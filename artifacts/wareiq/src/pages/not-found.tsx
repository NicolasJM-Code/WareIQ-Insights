import { Link } from 'wouter';
import { MapPinOff } from 'lucide-react';
import { useDocTitle } from '@/lib/report-context';

export default function NotFound() {
  useDocTitle('Location not found');
  return (
    <div className="min-h-[60vh] grid place-items-center text-center">
      <div>
        <MapPinOff className="h-10 w-10 mx-auto text-muted-foreground" />
        <h1 className="font-display text-3xl font-bold mt-3">Empty bin location</h1>
        <p className="text-sm text-muted-foreground mt-1">This page does not exist in WareIQ.</p>
        <Link href="/" className="inline-flex mt-4 h-9 px-4 items-center rounded-md bg-primary text-primary-foreground text-sm" data-testid="link-home">Back to dashboard</Link>
      </div>
    </div>
  );
}
