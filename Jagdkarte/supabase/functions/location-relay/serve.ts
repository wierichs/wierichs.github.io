import { handleRequest } from './index.ts';

Deno.serve(request => handleRequest(request));