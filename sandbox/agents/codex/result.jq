# Passes `codex exec --json` through as it comes, then adds one line of Deckhand's once it
# ends: {type: "deckhand.result", ok, text, duration_ms}, what the listener reads as the
# run's result (../../listener/agents/codex.mjs). ok: a turn completed and none failed. text:
# Codex's last message, or why the turn failed. Run with -nRr: each line is an input.
foreach ((inputs | {line: ., event: (fromjson? // null)}), {end: true}) as $in (
  {start: now, ok: false, failed: null, text: "", out: null};
  if $in.end then
    .out = ({
      type: "deckhand.result",
      ok: (.ok and .failed == null),
      text: (.failed // .text),
      duration_ms: ((now - .start) * 1000 | floor)
    } | tojson)
  else
    .out = $in.line
    | $in.event as $e
    | if ($e | type) != "object" then .
      elif $e.type == "item.completed" and $e.item.type == "agent_message" then
        .text = ($e.item.text // "")
      elif $e.type == "turn.completed" then .ok = true
      elif $e.type == "turn.failed" then .failed = ($e.error.message // "Codex's turn failed")
      else . end
  end;
  .out
)
