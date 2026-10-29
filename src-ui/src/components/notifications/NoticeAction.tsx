import type { ComponentProps } from 'react';
import { Button } from '../Button';
import './NoticeAction.css';

/** Action chrome shared by inbox cards and attention requests; mutations stay local. */
export function NoticeAction({
  className = '',
  ...props
}: ComponentProps<typeof Button>) {
  return <Button {...props} className={`notice-action ${className}`} />;
}
