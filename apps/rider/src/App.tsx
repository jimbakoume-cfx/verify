import { FlowView } from "./FlowView";
import { type Boot, useFlow } from "./flow/useFlow";

export function App({ boot, debug }: { boot: Boot; debug: boolean }) {
  const { state, actions } = useFlow(boot);
  return <FlowView state={state} actions={actions} debug={debug} />;
}
