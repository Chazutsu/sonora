export interface RenderableView {
	render(): void;
}

export class ViewRegistry<View extends RenderableView> {
	private readonly views = new Set<View>();

	get size(): number {
		return this.views.size;
	}

	add(view: View): void {
		this.views.add(view);
	}

	delete(view: View): void {
		this.views.delete(view);
	}

	renderAll(): void {
		for (const view of this.views) view.render();
	}
}
