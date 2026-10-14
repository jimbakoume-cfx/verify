import { useMemo } from "react";
import { FlowView } from "./FlowView";
import { parseChecksTiming } from "./flow/checks";
import { type Boot, type FlowOptions, useFlow } from "./flow/useFlow";

export function App({ boot, debug }: { boot: Boot; debug: boolean }) {
  // Debug mode only: the wait for the server's checks can be set from the URL (flow/checks.ts).
  const options = useMemo<FlowOptions>(
    () => (debug ? { checks: parseChecksTiming(window.location.search) } : {}),
    [debug],
  );
  const { state, actions } = useFlow(boot, options);
  return <FlowView state={state} actions={actions} debug={debug} />;
}
