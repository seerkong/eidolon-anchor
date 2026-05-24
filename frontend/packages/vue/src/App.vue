<template>
  <AppLayout :menus="menus" />
</template>

<script setup lang="ts">
import AppLayout from "./layout/AppLayout.vue";
import { appMenus } from "./router";

const menus = appMenus;
</script>
