import MarkdownView from "@/components/MarkdownView";

export default function SEOGuideRoute() {
  return (
    <div className="max-w-[860px] mx-auto">
      <div className="mb-6 flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.25em] text-[var(--fg-dimmer)] mb-1">
            Setup Guide
          </div>
          <h1 className="text-2xl font-medium">SEO Content Pipeline</h1>
        </div>
      </div>
      <MarkdownView src="/api/seo-guide" />
    </div>
  );
}
