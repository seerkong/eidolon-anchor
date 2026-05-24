import type { AppRouteConfig } from "@frontend/composer/router/types";

export const exampleRoutes: AppRouteConfig[] = [
  {
    path: "/example",
    name: "example-root",
    title: "示例模块",
    component: "layout",
    meta: { isMenu: true },
    children: [
      {
        path: "/example",
        redirect: "/example/post",
        meta: { isMenu: false, title: "示例模块" },
      },
      {
        path: "/example/post",
        name: "example-post",
        title: "POST示例",
        component: "modules/Example/view/ExamplePost",
        meta: { isMenu: true },
      },
      {
        path: "/example/sse",
        name: "example-sse",
        title: "SSE示例",
        component: "modules/Example/view/ExampleSse",
        meta: { isMenu: true },
      },
      {
        path: "/example/file-upload",
        name: "example-file-upload",
        title: "文件上传",
        component: "modules/Example/view/ExampleFileUpload",
        meta: { isMenu: true },
      },
      {
        path: "/example/nested",
        name: "example-nested",
        title: "二级嵌套层级示例",
        component: "modules/Example/view/NestedLevel2",
        meta: { isMenu: true },
        children: [
          {
            path: "/example/nested/level3",
            name: "example-nested-level3",
            title: "三级嵌套层级示例",
            component: "modules/Example/view/NestedLevel3",
            meta: { isMenu: true },
          },
        ],
      },
    ],
  },
];
