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
import { Construct } from "constructs";
import { StateMachine, Map, JsonPath, TaskInput, Wait, WaitTime } from "aws-cdk-lib/aws-stepfunctions";
import { EventBus } from "aws-cdk-lib/aws-events";
import { EventBridgePutEvents } from "aws-cdk-lib/aws-stepfunctions-tasks";

/**
 * Properties to initialize a workflow simulation state machine
 */
export interface WorkflowSimulationProps {
  /**
   * Event bus to use to put events.
   */
  eventBus: EventBus
}
/**
 * State machine that simulate choreographies by publishing events to EventBridge with scheduled delays.
 * The State machine accepts a list of events as input. Each event should have the following structure:
 * {
 *   "source": "<Source of event>"
 *   "detailType": "<Type of event>",
 *   "detail": {...}
 *   "wait": <Seconds to wait before publishing next event>
 * }
 */
export class WorkflowSimulationStateMachine extends StateMachine {
  
  constructor(scope: Construct, id: string, props: WorkflowSimulationProps) {
    super(scope, id, {
      definition: new Map(scope, "Map", {
        itemsPath: '$.events',
        maxConcurrency: 1,
        parameters: {
          "event.$": "$$.Map.Item.Value",
        }
      }).iterator(
        new EventBridgePutEvents(scope, "PublishEvent", {
          entries: [
            {
              source: JsonPath.stringAt("$.event.source"),
              detailType: JsonPath.stringAt("$.event.detailType"),
              eventBus: props.eventBus,
              detail: TaskInput.fromJsonPathAt('$.event.detail')
            }
          ],
          resultPath: '$.eventResult'
        }).next(new Wait(scope, "Wait", { time: WaitTime.secondsPath('$.event.wait')}))
      )
    })
  }

}