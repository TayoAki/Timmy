import { Library } from 'lucide-react';
import { Placeholder, SideHead } from '../../components/kit';


export function LibraryView() {
  return <Placeholder title="Library" />;
}

export function LibrarySide() {
  return <SideHead icon={<Library size={18} />} title="Library" />;
}

export function LibraryContext() {
  return null;
}
