
import { AiWebArchitectMesh } from './actor/mesh/AiWebArchitectMesh';
import { LayoutActorLogic } from './actor/layout/LayoutActorApi';
import { TechDocEditorActorLogic } from './actor/editor/logic/TechDocEditorActorLogic';


let mesh = new AiWebArchitectMesh();

// 1. 首先初始化布局
mesh.LayoutActorApi = new LayoutActorLogic(mesh);
await mesh.LayoutActorApi.mount();
await mesh.LayoutActorApi.connect();

// 2. 布局就绪后，初始化编辑器 Actor
mesh.TechDocEditorActorApi = new TechDocEditorActorLogic(mesh);
await mesh.TechDocEditorActorApi.mount();
await mesh.TechDocEditorActorApi.connect();

console.log('所有 Actor 初始化完成');
