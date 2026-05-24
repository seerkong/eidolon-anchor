import type { StdInnerLogic } from "depa-processor"
import type {
  ListCityMajorAtractionsInnerConfig,
  ListCityMajorAtractionsInnerInput,
  ListCityMajorAtractionsInnerOutput,
  ListCityMajorAtractionsInnerRuntime,
} from "./InnerTypes"

export const listCityMajorAtractionsCoreLogic: StdInnerLogic<
  ListCityMajorAtractionsInnerRuntime,
  ListCityMajorAtractionsInnerInput,
  ListCityMajorAtractionsInnerConfig,
  ListCityMajorAtractionsInnerOutput
> = async (_runtime, input, _config) => {
  const data: Record<string, string[]> = {
    "San Francisco": ["Golden Gate Bridge", "Alcatraz Island", "Fisherman's Wharf", "Chinatown"],
    "New York": ["Statue of Liberty", "Central Park", "Times Square", "Empire State Building"],
    "Los Angeles": ["Hollywood Sign", "Santa Monica Pier", "Universal Studios", "Getty Center"],
    Beijing: ["Great Wall", "Forbidden City", "Temple of Heaven", "Summer Palace"],
    Shanghai: ["The Bund", "Yu Garden", "Oriental Pearl Tower", "Nanjing Road"],
    Tokyo: ["Senso-ji Temple", "Shibuya Crossing", "Tokyo Tower", "Meiji Shrine"],
    London: ["Big Ben", "Tower of London", "British Museum", "Buckingham Palace"],
  }
  if (input.city) {
    for (const [city, attractions] of Object.entries(data)) {
      if (city.toLowerCase().includes(String(input.city).toLowerCase())) {
        return `Attractions in ${city}: ${attractions.join(", ")}`
      }
    }
    return `No attraction data for ${input.city}`
  }
  return (
    "Available cities and attractions:\n" +
    Object.entries(data)
      .map(([city, attractions]) => `${city}: ${attractions.join(", ")}`)
      .join("\n")
  )
}
