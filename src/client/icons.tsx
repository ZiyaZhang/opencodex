import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/csr/ArrowUpRight';
import { CodeIcon } from '@phosphor-icons/react/dist/csr/Code';
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal';

const icons = {
  refresh: ArrowClockwiseIcon, back: ArrowLeftIcon, external: ArrowUpRightIcon,
  code: CodeIcon, settings: SlidersHorizontalIcon,
};
export type IconName = keyof typeof icons;

/** One size and weight for the tool UI; adjacent text supplies the accessible name. */
export function Icon({ name, className = '', size = 16 }: { name: IconName; className?: string; size?: number }) {
  const Component = icons[name];
  return <Component size={size} weight="regular" className={`oc-icon ${className}`} aria-hidden="true" focusable="false" />;
}
