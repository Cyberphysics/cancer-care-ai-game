import { dispatch } from './router';
import type { ApiResponse, HttpApiEvent } from './types';

/**
 * Single entry point for the game API.
 *
 * One function handles every route: one artifact, one log group, one IAM role.
 * Route dispatch happens in `router.ts`. Phase 3 adds AgentCore Gateway tool
 * handlers alongside this file, sharing the same validation helpers.
 */
export const handler = async (event: HttpApiEvent): Promise<ApiResponse> => dispatch(event);
