import { MutationTypeEnum } from "./TechDesignDslDef";

export interface TechDesignDslMutationItem {
  mutationType: MutationTypeEnum;
  data: any;
}
