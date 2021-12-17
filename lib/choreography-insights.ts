/*
  Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.
  Permission is hereby granted, free of charge, to any person obtaining a copy of this
  software and associated documentation files (the "Software"), to deal in the Software
  without restriction, including without limitation the rights to use, copy, modify,
  merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
  permit persons to whom the Software is furnished to do so.
  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
  INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
  PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
  HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
  OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
  SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
// SPDX-License-Identifier: MIT-0
import * as cdk from "@aws-cdk/core";
import { AttributeType, BillingMode, Table, TableEncryption } from "@aws-cdk/aws-dynamodb";
import { StateMachine, StateMachineType, TaskStateBase, IChainable, State } from "@aws-cdk/aws-stepfunctions";
import { RetentionDays } from "@aws-cdk/aws-logs";
import { NodejsFunction } from "@aws-cdk/aws-lambda-nodejs";
import { IFunction, Tracing } from '@aws-cdk/aws-lambda';
import { EventPattern, EventBus, Rule, RuleTargetInput, EventField } from '@aws-cdk/aws-events';
import { ManagedPolicy, Policy, Role, PolicyStatement, ServicePrincipal, PolicyDocument } from '@aws-cdk/aws-iam';
import { LambdaFunction } from "@aws-cdk/aws-events-targets";
import { ChoreographyState, ChoreographyStateBuilder } from "./choreography-state";
import { Duration, Stack } from "@aws-cdk/core";

export interface ChoreographyInsightsProps {
  eventBus: EventBus,
  /**
   * How long, in days, the log contents will be retained.
   *
   * To retain all logs, set this value to RetentionDays.INFINITE.
   *
   * @default RetentionDays.ONE_YEAR
   * @stability stable
   */
  logRetention?: RetentionDays
}

export interface ChoreographyProps {
  definition: IChainable;
  startEvent: ChoreographyEvent;
  events: ChoreographyEvent[];
  timeout?: Duration
}

export interface ChoreographyEvent {
  pattern: EventPattern;
  entityIdJsonPath?: string;
}

/**
 * Construct to provision core resources to support choreography monitoring with Step Functions.
 * The Construct provision the following resources:
 * - A DynamoDB Table to store Task Tokens
 * - A Lambda function to start a new Step Functions state machine execution with an explicit name
 * - A lambda function to handle events by reading a Task Token from DynamoDB and invoking Step Functions SendTaskSuccess to resume execution
 * The Construct allows to monitor multiple Choreographies
 */
export class ChoreographyInsights extends cdk.Construct {

  public readonly taskTokensTable: Table;
  public readonly defaultStateBuilder: ChoreographyStateBuilder;

  private readonly eventHandlerTask: IFunction;
  private readonly initWorkflowTask: IFunction;
  private eventBus: EventBus;
  private choreographyList: Choreography[] = new Array();
  private readonly logRetention: RetentionDays;
  private readonly lambdaBaseExecutionRolePolicy: ManagedPolicy;
  private readonly logRetentionExecutionRolePolicy: ManagedPolicy;

  constructor(scope: cdk.Construct, id: string, props?: ChoreographyInsightsProps) {
    super(scope, id);

    this.logRetention = props?.logRetention || RetentionDays.ONE_YEAR;

    this.taskTokensTable = new Table(this, 'TaskTokensTable', {
      partitionKey: {
        name: 'entityId',
        type: AttributeType.STRING
      },
      sortKey: {
        name: 'eventName',
        type: AttributeType.STRING
      },
      
      encryption: TableEncryption.AWS_MANAGED,
      // The default removal policy is RETAIN, which means that cdk destroy will not attempt to delete
      // the new table, and it will remain in your account until manually deleted. By setting the policy to 
      // DESTROY, cdk destroy will delete the table (even if it has data in it)
      removalPolicy: cdk.RemovalPolicy.DESTROY, // NOT recommended for production code,
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true
    });

    this.lambdaBaseExecutionRolePolicy = this.basicLambdaExecutionRolePolicy();

    this.eventHandlerTask = this.eventHandlerFunction(this.taskTokensTable);
    this.initWorkflowTask = this.initWorkflowFunction(this.taskTokensTable);

    this.eventBus = props ? props.eventBus : new EventBus(this, "Bus");

    this.defaultStateBuilder = new ChoreographyStateBuilder(this, "Builder", {
      taskTokenTable: this.taskTokensTable
    });
  }

  /**
   * Bind the choreography provided as input to the resources provisioned by the ChoreographyInsights construct.
   * It adds relevant permission to interact with the Choreography State Machine and creates 2 EventBridge rules
   * to match the initial event and subsequent events that belongs to the choreography
   * @param choreography 
   */
  public addChoreography(choreography: Choreography) {
    choreography.stateMachine.grantStartExecution(this.initWorkflowTask);
    choreography.stateMachine.grantTaskResponse(this.eventHandlerTask);
    choreography.stateMachine.grantExecution(this.eventHandlerTask, "states:StopExecution");

    const entityId = this.getEntityId(choreography.startEvent);

    //Routing of the event that triggers the Workflow execution
    new Rule(this, `${choreography.node.id}StartEventRule`, {
      eventBus: this.eventBus,
      eventPattern: choreography.startEvent.pattern,
      targets: [new LambdaFunction(this.initWorkflowTask, {
        event: RuleTargetInput.fromObject({
          stateMachineArn: choreography.stateMachine.stateMachineArn,
          name: entityId, //Identifier of the workflow entity (i.e. '$.detail.id')
          input: {
            detail: EventField.fromPath('$.detail'),
            eventName: EventField.fromPath('$.detail-type'),
            entityId: this.getEntityId(choreography.startEvent)
          }
        })
      })]
    });

    //Routing subsequent events to trigger state machine transition
    new Rule(this, `${choreography.node.id}NextEventRule`, {
      eventBus: this.eventBus,
      eventPattern: choreography.events[0].pattern,
      targets: [new LambdaFunction(this.eventHandlerTask, {
        event: RuleTargetInput.fromObject({
          detail: EventField.fromPath('$.detail'),
          eventName: EventField.fromPath('$.detail-type'),
          entityId: this.getEntityId(choreography.events[0])
        })
      })]
    });

    this.choreographyList.push(choreography);
  }

  /**
   * Lambda function that handles events from the custom event bus,
   * retrieves task token based on entityId and event type and feed
   * the result to Step Functions calling SendTaskSuccess.
   * @param taskTokensTable 
   * @returns 
   */
  private eventHandlerFunction(taskTokensTable:Table):IFunction {
    const eventHandler = new NodejsFunction(this, 'EventHandler', {
      entry: __dirname + "/../resources/event_handler/app.ts", // accepts .js, .jsx, .ts and .tsx files
      handler: 'handler',
      environment: {
        TASK_TOKENS_TABLE_NAME: taskTokensTable.tableName
      },
      reservedConcurrentExecutions: 20,
      role: new Role(this, 'CustomEventHandlerExecutionRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [ this.lambdaBaseExecutionRolePolicy ]
      }),
      retryAttempts: 2
    });
    taskTokensTable.grantReadWriteData(eventHandler);
    return eventHandler;
  }

  /**
   * Lambda function that start the execution of the workflow state machine
   * @param taskTokensTable
   * @returns 
   */
  private initWorkflowFunction(taskTokensTable:Table): IFunction {
    //Initialize Workflow Function
    const initWorkflowHandler = new NodejsFunction(this, "InitWorkflowHandler", {
      entry: __dirname + "/../resources/initialize_workflow/app.ts", // accepts .js, .jsx, .ts and .tsx files
      handler: 'handler',
      environment: {
        TASK_TOKENS_TABLE_NAME: taskTokensTable.tableName
      },
      reservedConcurrentExecutions: 5,
      role: new Role(this, 'CustomInitWorkflowExecutionRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [ this.lambdaBaseExecutionRolePolicy ]
      }),
      retryAttempts: 2
    });
    taskTokensTable.grantWriteData(initWorkflowHandler);
    return initWorkflowHandler;
  }

  private basicLambdaExecutionRolePolicy(): ManagedPolicy {
    return new ManagedPolicy(this, "CustomBasicLambdaExecuctionRolePolicy", {
      statements: [
        new PolicyStatement({
          actions: [ "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
          resources: [ `arn:aws:logs:${Stack.of(this).region}:${Stack.of(this).account}:log-group:/aws/lambda/${Stack.of(this).stackName}*:*` ]
        })
      ]
    })
  }

  private getEntityId(event: ChoreographyEvent): string { 
    const path = event.entityIdJsonPath ? event.entityIdJsonPath : '$.detail.id';
    return EventField.fromPath(path);
  }
}

/**
 * Construct that models a choreography definition as a Step Functions state machine.
 * It checks that the definition provided in the properties contains only allowed State types (i.e. Task states must be instanceof ChoreographyState)
 */
export class Choreography extends cdk.Construct {

  public readonly stateMachine: StateMachine;
  public readonly startEvent: ChoreographyEvent;
  public readonly events: ChoreographyEvent[];

  constructor(scope: cdk.Construct, id: string, props: ChoreographyProps) {
    super(scope, id);
    this.checkDefinition(props.definition);
    this.startEvent = props.startEvent;
    this.events = props.events;
    this.stateMachine = new StateMachine(this, "StateMachine", {
      definition: props.definition,
      stateMachineType: StateMachineType.STANDARD,
      timeout: props.timeout
    });
  }

  private checkDefinition(definition: IChainable) {
    const states: State[] = State.findReachableStates(definition.startState);
    states.forEach(s => {
      if((s instanceof TaskStateBase) && !(s instanceof ChoreographyState)) {
        throw new Error(`State ${s.id} must be an instance of class ChoreographyState.`)
      }
    });
  }
}