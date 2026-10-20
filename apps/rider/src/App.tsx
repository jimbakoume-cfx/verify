import { useMemo } from "react";
import { FlowView } from "./FlowView";
import { parseChecksTiming } from "./flow/checks";
import { parseResultTiming } from "./flow/result";
import { type Boot, type FlowOptions, useFlow } from "./flow/useFlow";

export function App({ boot, debug }: { boot: Boot; debug: boolean }) {
  // Debug mode only: the waits for the server's checks and for the result can be set from the URL
  // (flow/checks.ts, flow/result.ts).
  const options = useMemo<FlowOptions>(
    () =>
      debug
        ? { checks: parseChecksTiming(window.location.search), result: parseResultTiming(window.location.search) }
        : {},
    [debug],
  );
  const { state, actions } = useFlow(boot, options);
  return <FlowView state={state} actions={actions} debug={debug} />;
}
