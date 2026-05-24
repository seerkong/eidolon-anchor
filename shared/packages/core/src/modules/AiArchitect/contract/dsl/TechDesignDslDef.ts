export const DomainDslTypes = [
  'Module', 'ModuleRelationDiagram',
  'Enum', 'Entity', 'EntityRelationDiagram',
  'HttpEndpoint', 'KafkaConsumer', 'PublicProcedure', 'PrivateProcedure',
  'StateMachine', 'BackendCache',
  'ViewComponent', 'Page'
];

export enum MutationTypeEnum {
  Create = 'Create',
  Update = 'Update',
  Delete = 'Delete'
}

export const DslTypeToStateKeyMap: any = {
  'Module': 'Module',
  'ModuleRelationDiagram': 'ModuleRelationDiagram',
  'Enum': 'Enum',
  'Entity': 'Entity',
  'EntityRelationDiagram': 'EntityRelationDiagram',
  'HttpEndpoint': 'HttpEndpoint',
  'KafkaConsumer': 'KafkaConsumer',
  'PublicProcedure': 'PublicProcedure',
  'PrivateProcedure': 'PrivateProcedure',
  'StateMachine': 'StateMachine',
  'BackendCache': 'BackendCache',
  'ViewComponent': 'ViewComponent',
  'Page': 'Page'
}

export interface TechDesignSnapshotDsl {
  Module: { [key: string]: ModuleItem };
  ModuleRelationDiagram: { [key: string]: ModuleRelationDiagramItem };
  Entity: { [key: string]: EntityItem };
  EntityRelationDiagram: { [key: string]: EntityRelationDiagramItem };
  Enum: { [key: string]: EnumItem };
  HttpEndpoint: { [key: string]: ProcedureItem };
  KafkaConsumer: { [key: string]: ProcedureItem };
  PublicProcedure: { [key: string]: ProcedureItem };
  PrivateProcedure: { [key: string]: ProcedureItem };
  StateMachine: { [key: string]: StateMachineItem };
  BackendCache: { [key: string]: BackendCacheItem };
  ViewComponent: { [key: string]: ViewComponentItem };
  Page: { [key: string]: PageItem };
}

export interface ModuleItem {
  version: number;
  title: string;
  businessDesc: string;
  techSummary: string;
  dependency: ModuleDependency;
}

export interface ModuleDependency {
  moduleIds: string[];
}

export interface ModuleRelationDiagramItem {
  version: number;
  title: string;
  mermaidDsl: string;
}

export interface EnumItem {
  version: number;
  title: string;
  businessDesc: string;
  typescript: string;
}

export interface EntityItem {
  version: number;
  title: string;
  businessDesc: string;
  typescript: string;
}

export interface EntityDependency {
  entityIds: string[];
}

export interface EntityRelationDiagramItem {
  version: number;
  title: string;
  mermaidDsl: string;
}

export interface ProcedureItem {
  version: number;
  title: string;
  businessDesc: string;
  techSummary: string;
  dependency: ProcedureDependency;
  typescript: string;
  ctrlFlowPseudocode: string;
  rulePseudocode: string;
  dataFlowPseudocode: string;
}

export interface ProcedureDependency {
  procedureIds: string[];
}

export interface StateMachineItem {
  version: number;
  title: string;
  pseudocode: string;
  mermaidDsl: string;
}

export interface BackendCacheItem {
  version: number;
  title: string;
  techSummary: string;
  cacheKey: string;
  cacheValueTypescript: string;
}

export interface ViewComponentItem {
  version: number;
  title: string;
  businessDesc: string;
  typescript: string;
  dependency: ViewComponentDependency;
}

export interface ViewComponentDependency {
  procedureIds: string[];
  viewComponentIds: string[];
}

export interface PageItem {
  version: number;
  title: string;
  businessDesc: string;
  dependency: PageDependency;
}

export interface PageDependency {
  viewComponentIds: string[];
}
