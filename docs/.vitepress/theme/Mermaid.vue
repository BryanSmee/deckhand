<script setup>
// A ```mermaid block, drawn in the browser: mermaid is only loaded on a page that has one, and
// the diagram is drawn again when the theme changes.
import { nextTick, onMounted, ref, useId, watch } from "vue";
import { useData } from "vitepress";

const props = defineProps({ code: { type: String, required: true } });
const { isDark } = useData();
const box = ref();
const svg = ref("");
const failed = ref(false);
const id = `mermaid-${useId()}`;
let rendering = Promise.resolve();

function draw() {
  rendering = rendering.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: isDark.value ? "dark" : "default",
      // Sized below (fit()): fitted to the column, the wide ones are unreadable.
      flowchart: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
    });
    try {
      svg.value = (await mermaid.render(id, decodeURIComponent(props.code))).svg;
      failed.value = false;
      await nextTick();
      fit(box.value?.querySelector("svg"));
    } catch (error) {
      console.error(error);
      failed.value = true;
    }
  });
}

// The column's width, never wider than the diagram, nor below three quarters of its size (its
// text at 12px): a wider one scrolls sideways.
function fit(el) {
  if (!el) return;
  const width = el.viewBox.baseVal.width;
  el.removeAttribute("width");
  el.removeAttribute("height");
  el.style.maxWidth = "none";
  el.style.width = `max(min(100%, ${width}px), ${Math.round(width * 0.75)}px)`;
}

onMounted(draw);
watch(isDark, draw);
</script>

<template>
  <div v-if="svg && !failed" ref="box" class="mermaid" v-html="svg" />
  <pre v-else class="mermaid-source"><code>{{ decodeURIComponent(code) }}</code></pre>
</template>

<style scoped>
.mermaid {
  margin: 16px 0;
  overflow-x: auto;
  text-align: center;
}
/* The page's paragraphs are taller than mermaid measured its labels: they were cut. */
.mermaid :deep(p) {
  line-height: inherit;
}
.mermaid-source {
  margin: 16px 0;
  padding: 16px;
  overflow-x: auto;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  font-size: var(--vp-code-font-size);
}
</style>
