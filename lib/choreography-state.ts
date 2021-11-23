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
import { Table } from "@aws-cdk/aws-dynamodb";
import { CallAwsService } from "@aws-cdk/aws-stepfunctions-tasks";
import { JsonPath } from "@aws-cdk/aws-stepfunctions";

/**
 * Properties to initialize a ChoreographyStateBuilder
 */
export interface ChoreographyStateBuilderProps {
  /**
   * Table to store Step Functions Task Tokens
   */
  taskTokenTable: Table;
  /**
   * Json Path from where to retrieve the correlation id
   * @default - $$.Execution.Input.detail.id
   */
  entityId?: string;
}

/**
 * Define a Choreography State.
 */
export class ChoreographyState extends CallAwsService {
  name: string;
  entityId: string;
  eventName: string;

  constructor(scope: cdk.Construct, builder: ChoreographyStateBuilder) {
    super(scope, builder.name, {
      service: 'dynamodb',
      action: 'updateItem.waitForTaskToken',
      parameters: {
        TableName: builder.taskTokenTable.tableName,
        Key: {
          entityId: {
            "S": builder.entityId
          },
          eventName: {
            "S": builder.eventName
          }
        },
        UpdateExpression: "SET taskToken = :token",
        ExpressionAttributeValues: {
          ":token": { "S": JsonPath.taskToken }
        }
      },
      iamResources: [builder.taskTokenTable.tableArn],
      iamAction: "dynamodb:updateItem"
    });
  }
}

/**
 * Builder class for Choreography States.
 */
export class ChoreographyStateBuilder extends cdk.Construct {
  private readonly _taskTokenTable: Table;
  private readonly _scope: cdk.Construct;
  private _name: string;
  private _entityId: string = JsonPath.stringAt("$$.Execution.Input.detail.id");
  private _eventName: string = "Default";

  constructor(scope: cdk.Construct, id: string, props: ChoreographyStateBuilderProps) {
    super(scope, id);
    this._scope = scope;
    this._taskTokenTable = props.taskTokenTable;
  }

  private reset() {
    this._entityId = JsonPath.stringAt("$$.Execution.Input.detail.id");
    this._eventName = "Default"
  }

  withName(name: string): ChoreographyStateBuilder {
    this._name = name;
    return this;
  }

  withEntityId(entityId: string): ChoreographyStateBuilder {
    this._entityId = entityId;
    return this;
  }

  withEventName(eventName: string) {
    this._eventName = eventName;
    return this;
  }

  get name() {
    return this._name;
  }

  get entityId() {
    return this._entityId;
  }

  get eventName() {
    return this._eventName;
  }

  get taskTokenTable() {
    return this._taskTokenTable;
  }
  
  build() {
    const state = new ChoreographyState(this._scope, this);
    this.reset();
    return state;
  }
}