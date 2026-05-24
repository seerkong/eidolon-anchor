import { describe, expect, it } from "bun:test";
import {
  AiAgentMode,
  DomainDslTypes,
  DslTypeToStateKeyMap,
  EmptyDesignDsl,
  MutationTypeEnum,
} from "../index";

describe("@shared/core exports", () => {
  it("re-exports AiArchitect enum and dsl constants", () => {
    expect(AiAgentMode.ResetInputAndInitModules).toBe("reset-input-and-init-modules");
    expect(AiAgentMode.ModuleDesign).toBe("module-design");

    expect(MutationTypeEnum.Create).toBe("Create");
    expect(MutationTypeEnum.Update).toBe("Update");
    expect(MutationTypeEnum.Delete).toBe("Delete");

    expect(DomainDslTypes).toContain("Module");
    expect(DslTypeToStateKeyMap.Module).toBe("Module");
  });

  it("re-exports AiArchitect sample data", () => {
    expect(Object.keys(EmptyDesignDsl).sort()).toEqual([...DomainDslTypes].sort());
    expect(EmptyDesignDsl.Module).toEqual({});
    expect(EmptyDesignDsl.Page).toEqual({});
  });
});
