# Turns `codex exec --json` (with result.jq's last line) into readable progress: Codex's
# messages, one line per command, edit or tool call, and a closing summary. Lines that are
# not JSON pass through.
(fromjson? // { type: "raw", text: . }) as $m
| if $m.type == "item.completed" and $m.item.type == "agent_message" then
    "\n" + $m.item.text + "\n"
  elif $m.type == "item.started" and $m.item.type == "command_execution" then
    "  → " + ($m.item.command | split("\n")[0] | .[0:100]) + "\n"
  elif $m.type == "item.completed" and $m.item.type == "file_change" then
    ($m.item.changes[]? | "  → " + .kind + " " + .path + "\n")
  elif $m.type == "item.started" and $m.item.type == "mcp_tool_call" then
    "  → " + $m.item.server + " " + $m.item.tool + "\n"
  elif $m.type == "deckhand.result" then
    "\n" + (if $m.ok then "Done" else "Failed: " + $m.text end)
    + " in \(($m.duration_ms / 6000 | floor) / 10) min\n"
  elif $m.type == "raw" then $m.text + "\n"
  else empty end
