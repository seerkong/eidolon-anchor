import { OpenAICompletionsNodejsFetchLlmAdapter } from "../src/llm/OpenAICompletionsNodejsFetchAdapter";
import { recordProviderCacheUsage } from "../src/llm/ProviderCacheUsage";
import { buildDeepSeekProviderDriver } from "../src/llm/drivers/DeepSeekDriver";
import {
  bindProviderCacheUsageToObservation,
  compareProviderCacheCostObservations,
  createProviderCacheCostObservation,
} from "../src/llm/ProviderCacheCostObservation";
import { runProviderCacheProductLive } from "../src/llm/ProviderCacheProductLive";

void OpenAICompletionsNodejsFetchLlmAdapter;
void recordProviderCacheUsage;
void buildDeepSeekProviderDriver;
void compareProviderCacheCostObservations;
void createProviderCacheCostObservation;
void bindProviderCacheUsageToObservation;
void runProviderCacheProductLive;
