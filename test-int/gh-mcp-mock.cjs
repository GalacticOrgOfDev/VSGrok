// Mock of GitHub's remote MCP server for the integration tests: Bearer auth, readOnlyHint annotations.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
function build(seen) {
  const s = new Server({ name: 'github-mock', version: '1.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'get_me', description: 'Get the authenticated user', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
    { name: 'create_repository', description: 'Create a repository', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, annotations: { readOnlyHint: false } },
  ] }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    seen.calls.push(req.params.name);
    if (req.params.name === 'get_me') { return { content: [{ type: 'text', text: '{"login":"octo-test"}' }] }; }
    if (req.params.name === 'create_repository') { return { content: [{ type: 'text', text: 'created ' + req.params.arguments.name }] }; }
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  });
  return s;
}
module.exports = { build };
