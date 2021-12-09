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
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {  Choice, Succeed, Fail, Condition, Parallel, IChainable, JsonPath } from "aws-cdk-lib//aws-stepfunctions";
import { EventBus } from "aws-cdk-lib/aws-events";
import { WorkflowSimulationStateMachine } from './workflow-simulation';
import { Choreography, ChoreographyInsights } from './choreography-insights';
import { ChoreographyStateBuilder } from './choreography-state';
export class ChoreographyInsightsStack extends cdk.Stack {
  
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const eventBus = new EventBus(this, "EventBus");
    
    const insights = new ChoreographyInsights(this, "Choreography", { eventBus: eventBus });

    const builder = new ChoreographyStateBuilder(this, "Builder", {
      taskTokenTable: insights.taskTokensTable,
      entityId: JsonPath.stringAt("$$.Execution.Input.id")
    });

    //Order
    const orderWorkflow = this.orderWorkflowDefinition(builder);
    const orderChoreography = new Choreography(this, "Order", {
      definition: orderWorkflow,
      startEvent: {
        pattern: { source: ["order"], detailType: ["Order Placed"] }
      },
      events: [{
        pattern: { source: ["order"], detailType: [ { "anything-but": "Order Placed"} ] as any[] }
      }]
    });
    insights.addChoreography(orderChoreography);

    //Car
    const carWorkflow = this.carWorkflowDefinition(builder);
    const carChoreography = new Choreography(this, "Car", {
      definition: carWorkflow,
      startEvent: {
        pattern: { source: ["car"], detailType: ["Car Announced"] }
      },
      events: [{
        pattern: { source: ["car"], detailType: [ { "anything-but": "Car Announced"} ] as any[] }
      }]
    });
    insights.addChoreography(carChoreography);

    //Workflow simulation
    new WorkflowSimulationStateMachine(this, "WorkflowSimulation", { eventBus: eventBus });

  }

  /**
   * Sample workflow #1 - Order processing for a marketplace, accepting requests and forwarding to service providers
   * 1. Order Placed: a new order has been placed. The state machine is waiting for the confermation
   * 2. Order Confirmed: the order has been confirmed by sending a request to the service provider. The state machine is waiting for the service provider to accept the order.
   * 3. Order Accepted: the service provider accepted the order. the state machine will wait for the order delivery aknowledgement
   * 4. Order Rejected: the service provider rejected the order. Marketplace should cancel the order. The state machine will wait for the Order Canceled event
   * 5. Order Canceled: The customer did not confirm the order or the service provider did not complete delivery. The state machine reach final state OrderCanceled.
   * 6. Order Delivered: When the service provider accept the order it proceeds with delivery and when it's done provide aknowledgement with an event. The state machine reach final state OrderCompleted.
   * @param builder 
   * @returns 
   */
  orderWorkflowDefinition(builder: ChoreographyStateBuilder): IChainable {

    const waitForConfirmation = builder.withName("WaitForConfirmation").build();
    const waitForServiceProviderToAccept = builder.withName("WaitForServiceProviderAccept").build();
    const waitForServiceProviderDelivery = builder.withName("WaitForServiceProviderDelivery").build();
    const waitForCanceled = builder.withName("WaitForCanceled").build();

    const orderCanceled = new Succeed(this, "OrderCanceled");
    const orderCompleted = new Succeed(this, "OrderCompleted");
    const unexpectedTransition = new Fail(this, "UnexpectedTransition");

    const deliveryChoice = new Choice(this, "Delivered?")
      .when(Condition.stringEquals("$.eventName", "Order Delivered"), orderCompleted)
      .when(Condition.stringEquals("$.eventName", "Order Canceled"), orderCanceled)
      .otherwise(unexpectedTransition);

    const orderAcceptedBranch = waitForServiceProviderDelivery.next(deliveryChoice);

    const orderRejectedBranch = waitForCanceled
      .next(new Choice(this, "Canceled?")
      .when(Condition.stringEquals("$.eventName", "Order Canceled"), orderCanceled)
      .otherwise(unexpectedTransition));

    return waitForConfirmation
      .next(new Choice(this, "Confirmed?")
        .when(Condition.stringEquals("$.eventName", "Order Confirmed"),
          waitForServiceProviderToAccept
          .next(new Choice(this, "Accepted?")
            .when(Condition.stringEquals("$.eventName", "Order Accepted"), orderAcceptedBranch)
            .when(Condition.stringEquals("$.eventName", "Order Rejected"), orderRejectedBranch)
            .otherwise(unexpectedTransition)))
        .otherwise(unexpectedTransition)
      );
  }

  /**
   * Sample workflow #2 - Car journey for a second hand car dealership
   * 1. Car Announcement: A supplier announce that a new car is available to be purchased from the dealer publishing a Car Announced event
   * 2. Inspection: The dealer perform an inspection on the car. At the end of the inspection a Inspection Completed event is published with the result (Success, Rejected)
   * 3. Preparation: When inspection is successful, the dealer buy the car from the supplier and prepare it for reselling it. The preparation involves 3 separate tasks
   *    3.1 Cleaning: Car is cleaned. At task completion, a Car Cleaned event is published
   *    3.2 Repairing: Eventual damages are repaired. At task completion, a Car Repaired event is published
   *    3.3 Evaluating: A reselling price is calculated for the car. At task completion, a Car Priced event is published
   * 4. Ready for Sale: The car is ready to be published to the selling channel
   * 5. On Sale: A Car Published event indicates that the car is advertized on sales channels (i.e. ecommerce, apps, etc).
   *    5.1 The car can also be removed from adv channels. This is aknowledged with a Car Unpublished event. This cause the transition back to the Ready for Sale state.
   * 6. Reserved: A Car Reserved event published on the bus indicates that the someone is interested in the car and the purchasing process is in progress.
   *    6.1 If purchasing is canceled, a Car Unreserved event is published which brings the workflow to the On Sale state
   * 7. Sold: Purchase is completed and a Car Sold event is published. When the car is sold 2 things need to happen:
   *    7.1 The dealer generate an invoice and send it to the buyer. At task completion, a Car Invoiced event is published
   *    7.2 The dealer deliver the car to the buyer. At task completion, a Car Invoiced event is published
   * @param builder 
   * @returns 
   */
  carWorkflowDefinition(builder: ChoreographyStateBuilder): IChainable {

    const announced = builder.withName("Announced").build();
    const rejected = new Succeed(this, "Rejected");

    /**
     * Parallel state can model a set of events that do not have string ordering among themselves.
     * A car requires to be cleaned, repaired and priced before being advertized. Ordering of these events is not important.
     * What is important is that all 3 are completed.
     * */
    const inPreparation = new Parallel(this, "InPreparation");
    inPreparation.branch(
      builder.withName("Clean").withEventName("Car Cleaned").build(),   //Create a state named 'Clean' which waits for an event with detailType = 'Car Cleaned'
      builder.withName("Repair").withEventName("Car Repaired").build(), //Create a state named 'Repair' which waits for an event with detailType = 'Car Repaired'
      builder.withName("Evaluate").withEventName("Car Priced").build()  //Create a state named 'Evaluate' which waits for an event with detailType = 'Car Priced'
    )

    const ready = builder.withName("ReadyForSale").build();
    const available = builder.withName("OnSale").build();
    const reserved = builder.withName("Reserved").build();
    
    const sold = new Parallel(this, "Sold");
    sold.branch(
      builder.withName("Delivery").withEventName("Car Delivered").build(),
      builder.withName("Invoice").withEventName("Invoice Sent").build()
    )

    const unexpectedTransition = new Fail(this, "Unexpected Transition");

    return announced
      .next(new Choice(this, "Is Accepted?")
        .when(Condition.and(Condition.stringEquals("$.eventName", "Inspection Completed"), Condition.stringEquals("$.detail.result", "Rejected")), rejected)
        .when(Condition.and(Condition.stringEquals("$.eventName", "Inspection Completed"), Condition.stringEquals("$.detail.result", "Success")),
          inPreparation.next(ready)
          .next(new Choice(this, "Is On Sale?")
            .when(Condition.stringEquals("$.eventName", "Car Published"), available
              .next(new Choice(this, "Is Reserved?")
                .when(Condition.stringEquals("$.eventName", "Car Unpublished"), ready)
                .when(Condition.stringEquals("$.eventName", "Car Reserved"), 
                  reserved
                  .next(new Choice(this, "Is Sold?")
                    .when(Condition.stringEquals("$.eventName", "Car Unreserved"), available)
                    .when(Condition.stringEquals("$.eventName", "Car Sold"), sold)
                    .otherwise(unexpectedTransition)
                  )
                )
                .otherwise(unexpectedTransition)
              )
            )
            .otherwise(unexpectedTransition)
          )
        )
        .otherwise(unexpectedTransition)
      );
  }
}


