import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatDayShort, offsetDate, todayJkt } from "../format";

export function IconButton({
  label,
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function DateNavigator({
  date,
  onChange,
}: {
  date: string;
  onChange: (date: string) => void;
}) {
  const today = todayJkt();
  return (
    <div className="date-navigator" aria-label="Selected date">
      <IconButton
        label="Previous day"
        onClick={() => onChange(offsetDate(date, -1))}
      >
        <ChevronLeft size={16} />
      </IconButton>
      <button
        className="date-label"
        onClick={() => onChange(today)}
        title="Return to today"
      >
        {date === today ? "Today" : formatDayShort(date)}
      </button>
      <IconButton
        label="Next day"
        disabled={date >= today}
        onClick={() => onChange(offsetDate(date, 1))}
      >
        <ChevronRight size={16} />
      </IconButton>
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state" role="status">
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
