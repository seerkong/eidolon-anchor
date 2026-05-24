import type { StdInnerLogic } from "depa-processor"
import type { GetWeatherInnerConfig, GetWeatherInnerInput, GetWeatherInnerOutput, GetWeatherInnerRuntime } from "./InnerTypes"

export const getWeatherCoreLogic: StdInnerLogic<
  GetWeatherInnerRuntime,
  GetWeatherInnerInput,
  GetWeatherInnerConfig,
  GetWeatherInnerOutput
> = async (_runtime, input, _config) => {
  const mock: Record<string, string> = {
    "San Francisco": "18°C, foggy",
    "New York": "22°C, partly cloudy",
    "Los Angeles": "28°C, sunny",
    Beijing: "15°C, hazy",
    Shanghai: "20°C, cloudy",
    Tokyo: "19°C, clear",
    London: "14°C, rainy",
  }
  for (const [city, weather] of Object.entries(mock)) {
    if (city.toLowerCase().includes(String(input.location || "").toLowerCase())) {
      return `Weather in ${input.location}: ${weather}`
    }
  }
  return `Weather in ${input.location}: 24°C, sunny (mock data)`
}
