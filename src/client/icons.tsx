import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/csr/ArrowUpRight';
import { BooksIcon } from '@phosphor-icons/react/dist/csr/Books';
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleIcon } from '@phosphor-icons/react/dist/csr/Circle';
import { ClockIcon } from '@phosphor-icons/react/dist/csr/Clock';
import { CodeIcon } from '@phosphor-icons/react/dist/csr/Code';
import { DesktopIcon } from '@phosphor-icons/react/dist/csr/Desktop';
import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText';
import { GaugeIcon } from '@phosphor-icons/react/dist/csr/Gauge';
import { ImageIcon } from '@phosphor-icons/react/dist/csr/Image';
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { PackageIcon } from '@phosphor-icons/react/dist/csr/Package';
import { PauseIcon } from '@phosphor-icons/react/dist/csr/Pause';
import { PlayIcon } from '@phosphor-icons/react/dist/csr/Play';
import { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus';
import { BroadcastIcon } from '@phosphor-icons/react/dist/csr/Broadcast';
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/csr/SlidersHorizontal';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';

const icons = {
  refresh: ArrowClockwiseIcon, back: ArrowLeftIcon, external: ArrowUpRightIcon,
  books: BooksIcon, next: CaretRightIcon, check: CheckCircleIcon, circle: CircleIcon,
  clock: ClockIcon, code: CodeIcon, desktop: DesktopIcon, file: FileTextIcon,
  gauge: GaugeIcon, image: ImageIcon, search: MagnifyingGlassIcon, package: PackageIcon,
  pause: PauseIcon, play: PlayIcon, plus: PlusIcon, radar: BroadcastIcon,
  settings: SlidersHorizontalIcon, warning: WarningCircleIcon, close: XIcon,
};
export type IconName = keyof typeof icons;

/** One size and weight for the tool UI; adjacent text supplies the accessible name. */
export function Icon({ name, className = '', size = 16 }: { name: IconName; className?: string; size?: number }) {
  const Component = icons[name];
  return <Component size={size} weight="regular" className={`oc-icon ${className}`} aria-hidden="true" focusable="false" />;
}
