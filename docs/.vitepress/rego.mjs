// A small grammar for Rego (Shiki has none): the policies' examples get their comments, strings
// and keywords coloured, without a package for it.
export const rego = {
  name: "rego",
  scopeName: "source.rego",
  patterns: [
    { name: "comment.line.number-sign.rego", match: "#.*$" },
    {
      name: "string.quoted.double.rego",
      begin: '"',
      end: '"',
      patterns: [{ name: "constant.character.escape.rego", match: "\\\\." }],
    },
    { name: "string.quoted.raw.rego", begin: "`", end: "`" },
    {
      name: "keyword.other.rego",
      match: "\\b(package|import|default|not|some|every|if|contains|in|else|with|as)\\b",
    },
    { name: "constant.language.rego", match: "\\b(true|false|null|input|data)\\b" },
    { name: "constant.numeric.rego", match: "\\b\\d+(\\.\\d+)?\\b" },
    { name: "keyword.operator.rego", match: ":=|==|!=|<=|>=|=|<|>|\\|" },
    { name: "entity.name.function.rego", match: "\\b[a-zA-Z_][a-zA-Z0-9_]*(?=\\s*\\()" },
  ],
};
