// What the listener takes from graphql-js (github-graphql.mjs), bundled into graphql.mjs at
// image build (../Dockerfile): the released image has no node_modules (AGENTS.md).
// update-schema.mjs imports its own from the package: none of it is the listener's.
export {
  buildSchema,
  getArgumentValues,
  getOperationAST,
  getVariableValues,
  Kind,
  OverlappingFieldsCanBeMergedRule,
  parse,
  print,
  specifiedRules,
  validate,
} from "graphql";
