/**
 * Vertical (Business Line) Type Definitions - Frontend
 * 
 * Mirrors the backend vertical types for consistent handling across the application.
 */

export type Vertical = 'isprava' | 'lohono_stays' | 'the_chapter' | 'solene';

/**
 * Default vertical when none is specified
 */
export const DEFAULT_VERTICAL: Vertical = 'isprava';

/**
 * Array of all available verticals
 */
export const VERTICALS: Vertical[] = [
    'isprava',
    'lohono_stays',
    'the_chapter',
    'solene',
];

/**
 * Human-readable display names for each vertical
 */
export const VERTICAL_DISPLAY_NAMES: Record<Vertical, string> = {
    isprava: 'Isprava',
    lohono_stays: 'Lohono Stays',
    the_chapter: 'The Chapter',
    solene: 'Solene',
};

/**
 * Get display name for a vertical
 */
export function getVerticalDisplayName(vertical: Vertical): string {
    return VERTICAL_DISPLAY_NAMES[vertical];
}

/**
 * Check if a value is a valid vertical
 */
export function isValidVertical(value: unknown): value is Vertical {
    return typeof value === 'string' && VERTICALS.includes(value as Vertical);
}
