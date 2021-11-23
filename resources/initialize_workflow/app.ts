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
// Function: initialize_workflow:app.js
import { SFN } from "@aws-sdk/client-sfn";
import { DynamoDB } from "@aws-sdk/client-dynamodb";

const sfn = new SFN({});
const dynamoDB = new DynamoDB({});

const taskTokenTableName = process.env.TASK_TOKENS_TABLE_NAME;

export const handler = async (event: any): Promise<any> => {
    
  try {
    const execution = await sfn.startExecution({
      stateMachineArn: event.stateMachineArn,
      name: event.name,
      input: JSON.stringify(event.input)
    });
    if(!execution.executionArn) {
      throw new Error("ExecutionArn is undefined.")
    }
    const saveExecution = await dynamoDB.updateItem({
      TableName: taskTokenTableName,
      Key: {
        "entityId": { "S": event.name },
        "eventName": { "S": "Default" }
        },
      UpdateExpression: "SET executionArn = :execArn",
      ExpressionAttributeValues: {
        ":execArn": { "S": execution.executionArn }
      }
    });
    return {
      statusCode: 200,
      body: 'OK'
    }
  } catch(e) {
    console.error(`Error starting new execution for state machine ${event.stateMachineArn}. ${JSON.stringify(e.stack)}`);
    throw e;
  }  
}
