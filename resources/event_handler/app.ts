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
// Function: event_handler:app.js
import { DynamoDB } from "@aws-sdk/client-dynamodb";
import { SFN } from "@aws-sdk/client-sfn";

const dynamoDB = new DynamoDB({});
const sfn = new SFN({});

const taskTokenTableName = process.env.TASK_TOKENS_TABLE_NAME;

export const handler = async (event: any): Promise<any> => {
    console.log("Event coming from Event Bridge. Sending feedback to Step Functions...");
    console.log(JSON.stringify(event));
    console.log("event name: " + event.eventName);
    const res = await dynamoDB.query({
      TableName: taskTokenTableName,
      KeyConditionExpression: 'entityId = :hkey',
      ExpressionAttributeValues: {
        ":hkey": { "S": event.entityId }
      }
    });
    if(res.Items && res.Items.length > 0) {
      if(res.Items.length == 1) {
        console.log("Single event state");
        await sfn.sendTaskSuccess({
          taskToken: res.Items[0].taskToken.S,
          output: JSON.stringify(event)
        });
        return {
          statusCode: 200,
          body: 'OK'
        };
      } else {
        console.log("Parallel event state");
        let executionArn;
        for(let i=0; i<res.Items.length; i++) {
          if(res.Items[i].eventName.S === "Default") {
            executionArn = res.Items[i].executionArn.S
          } else if(res.Items[i].eventName.S === event.eventName) {
            await sfn.sendTaskSuccess({
              taskToken: res.Items[i].taskToken.S,
              output: JSON.stringify(event)
            });
            await dynamoDB.deleteItem({
              TableName: taskTokenTableName,
              Key: {
                "entityId": { "S": event.entityId },
                "eventName": { "S": event.eventName }
              }
            })
            return {
              statusCode: 200,
              body: 'OK'
            };
          }
        }
        await sfn.stopExecution({
          executionArn: executionArn,
          error: "500",
          cause: `Unexpected event ${event.eventName} for EntityId: ${event.entityId}.`
        })/*.sendTaskFailure({
          taskToken: res.Items[res.Items.length-2].taskToken.S,
          error: "500",
          cause: `Unexpected event ${event.eventName} for EntityId: ${event.entityId}.`
        });*/
        return {
          statusCode: 200,
          body: 'OK'
        };
      }
    }
}
