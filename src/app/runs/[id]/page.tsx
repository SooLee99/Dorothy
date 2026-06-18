'use client';

import { use } from 'react';
import RunDetail from '@/components/RunDetail';

export default function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RunDetail runId={id} />;
}
