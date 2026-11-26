/** Source registration for canvas fixtures; input behavior stays with each fixture. */
export function inputSourceFixture() {
  let nextId = 0;
  const sources = new Set<string>();
  return {
    leaseReply(body: { action?: string; sourceId?: string }): Response | null {
      if (body.action === 'open-input-source') {
        const sourceId = `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;
        sources.add(sourceId);
        return Response.json({ success: true, data: { sourceId } });
      }
      if (body.action === 'close-input-source') {
        const closed =
          body.sourceId !== undefined && sources.delete(body.sourceId);
        return Response.json(
          { success: closed },
          { status: closed ? 200 : 403 },
        );
      }
      return null;
    },
    accepts(sourceId: unknown): boolean {
      return typeof sourceId === 'string' && sources.has(sourceId);
    },
  };
}
