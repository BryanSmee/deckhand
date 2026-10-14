# Turns `claude -p --output-format stream-json` into readable progress: Claude's messages,
# one line per tool call, and a closing summary. Lines that are not JSON pass through.
(fromjson? // { type: "raw", text: . }) as $m
| if $m.type == "assistant" then
    $m.message.content[]?
    | if .type == "text" then "\n" + .text + "\n"
      elif .type == "tool_use" then
        "  → " + .name + " "
        + ((.input.description // .input.command // .input.file_path // .input.pattern
            // .input.url // "") | tostring | split("\n")[0] | .[0:100])
        + "\n"
      else empty end
  elif $m.type == "result" then
    "\n" + (if $m.is_error then "Failed" else "Done" end)
    + " in \(($m.duration_ms / 6000 | floor) / 10) min\n"
  elif $m.type == "raw" then $m.text + "\n"
  else empty end
