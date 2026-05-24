import { useGraphSignal } from "depa-data-graph-solid"
import { createSimpleContext } from "../../../providers/helper"
import { useTuiA1State } from "../state/state-context"
import type { Route } from "./route"

export const { use: useRoute, provider: RouteProvider } = createSimpleContext({
  name: "TuiA1Route",
  init: () => {
    const { stateGraph } = useTuiA1State()
    const route = useGraphSignal<Route, undefined>(stateGraph.graph, "route")

    return {
      get data() {
        return route()
      },
      navigate(route: Route) {
        stateGraph.setRoute(route)
      },
    }
  },
})

export type RouteContext = ReturnType<typeof useRoute>

export function useRouteData<T extends Route["type"]>(type: T) {
  const route = useRoute()
  return route.data as Extract<Route, { type: typeof type }>
}
