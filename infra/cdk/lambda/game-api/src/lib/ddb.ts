import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Shared DynamoDB client.
 *
 * Built at module scope so a warm Lambda invocation reuses the connection and
 * the credential cache instead of paying for both on every request.
 */
const client = new DynamoDBClient({});

export const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    // Belt and braces with `omitUndefined` in lib/keys.ts. DynamoDB rejects
    // undefined attributes outright, and the failure surfaces only at write
    // time — never at synth or type-check time.
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
  unmarshallOptions: {
    wrapNumbers: false,
  },
});

/**
 * The game table name, injected by CDK.
 *
 * Throws rather than defaulting to an empty string: a misconfigured function
 * should fail loudly on the first request, not silently address a table named "".
 */
export function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) {
    throw new Error('TABLE_NAME environment variable is not set');
  }
  return name;
}
