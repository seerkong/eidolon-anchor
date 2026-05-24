<template>
  <div class="menu-item">
    <button
      class="menu-button"
      :class="{ active: isActive, 'has-children': hasChildren, 'is-child': isChild }"
      :style="indentStyle"
      @click="handleClick"
    >
      <span v-if="!collapsed" class="menu-label">
        <span v-if="hasChildren" class="menu-arrow" :class="{ open }">▸</span>
        {{ menu.title }}
      </span>
      <span v-else class="menu-dot"></span>
    </button>
    <div v-if="hasChildren && open" class="menu-children" :class="{ nested: isChild }">
      <SidebarMenuItem
        v-for="child in menu.children"
        :key="child.fullPath"
        :menu="child"
        :active-path="activePath"
        :collapsed="collapsed"
        :depth="depth + 1"
        @navigate="$emit('navigate', $event)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { AppMenuItem } from "../router/types";

defineOptions({ name: "SidebarMenuItem" });

const props = defineProps<{
  menu: AppMenuItem;
  activePath: string;
  collapsed: boolean;
  depth?: number;
}>();

const emit = defineEmits<{
  (e: "navigate", path: string): void;
}>();

const open = ref(true);
const depth = computed(() => props.depth ?? 0);
const hasChildren = computed(() => (props.menu.children?.length ?? 0) > 0);
const isChild = computed(() => depth.value > 0);
const isActive = computed(() => props.activePath.startsWith(props.menu.fullPath));
const indentStyle = computed(() => {
  if (props.collapsed) return {};
  return { paddingLeft: "12px" };
});

const handleClick = () => {
  if (hasChildren.value) {
    open.value = !open.value;
  } else {
    emit("navigate", props.menu.fullPath);
  }
};
</script>
