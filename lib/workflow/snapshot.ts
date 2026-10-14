import { type RunState } from "./schema";

/** HTTP replies can arrive after newer SSE events; never rewind a run. */
export function newestSnapshot(
  current: RunState | undefined,
  incoming: RunState,
): RunState {
  if (
    current?.id === incoming.id &&
    (current.events.at(-1)?.seq ?? 0) >= (incoming.events.at(-1)?.seq ?? 0)
  )
    return current;
  return incoming;
}
