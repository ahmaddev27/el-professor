import { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

/** Every string the rendered tree prints, flattened. */
export function textOf(tree: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(tree.toJSON());
  return out.join(' | ');
}

/** Lets effects, the loads they start and a rejected load's catch all run. */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

/** Buttons (host `button`, or a component whose props carry `onClick`) drawing a lucide icon. */
export function buttonsWithIcon(tree: ReactTestRenderer, iconName: string): ReactTestInstance[] {
  return tree.root.findAll(node =>
    node.type === 'button'
    && node.findAll(n => n.type === 'svg' && String(n.props.className ?? '').includes(iconName)).length > 0);
}

/** Host buttons whose own text is exactly `label`. */
export function buttonsLabelled(tree: ReactTestRenderer, label: string): ReactTestInstance[] {
  return tree.root.findAll(node => node.type === 'button' && flatText(node) === label);
}

export function flatText(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(flatText).join('');
}

export async function press(button: ReactTestInstance): Promise<void> {
  await act(async () => { button.props.onClick({ preventDefault() {}, stopPropagation() {} }); });
  await settle();
}
