import { describe, expect, it } from "bun:test";
import {
	EmptyDesignDsl,
	MutationTypeEnum,
	type TechDesignDslMutationItem,
	type TechDesignSnapshotDsl,
} from "../../../core/src/index";
import {
	API_URL_PROJECT_DETAIL,
	AppConstConfig,
	ExampleApiType,
	InfraApiType,
	LocalAIAssistantApi,
	type SSEChatDataResultData,
	SSEChatEventType,
	type UpdateTechDocDslRequest,
} from "../index";

describe("@shared/composer exports", () => {
	it("re-exports key runtime values from package entrypoint", () => {
		expect(AppConstConfig.displayName).toBe("Eidolon Anchor");
		expect(InfraApiType.HealthCheck).toBe("/api/health");
		expect(ExampleApiType.GetDemo).toBe("/api/example/demo");
		expect(LocalAIAssistantApi.ListDirectory).toBe(
			"/api/local-ai-assistant/list-directory",
		);
		expect(SSEChatEventType.done).toBe("done");
		expect(API_URL_PROJECT_DETAIL).toBe("/api/project/detail");
	});

	it("keeps composer AiArchitect API types aligned with @shared/core dsl types", () => {
		const snapshot: TechDesignSnapshotDsl = { ...EmptyDesignDsl };
		const mutation: TechDesignDslMutationItem = {
			mutationType: MutationTypeEnum.Create,
			data: {},
		};

		const updateRequest: UpdateTechDocDslRequest = {
			projectKey: "project-key",
			conversationUniqueId: "conversation-id",
			techDocDsl: snapshot,
		};

		const resultData: SSEChatDataResultData = {
			answerMutation: { module: { mutation } },
			conversationMutation: { module: { mutation } },
			newState: snapshot,
			confirmForm: [],
		};

		expect(updateRequest.techDocDsl).toBe(snapshot);
		expect(resultData.answerMutation.module.mutation.mutationType).toBe(
			"Create",
		);
	});
});
