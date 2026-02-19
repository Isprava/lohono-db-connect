/**
 * Vertical (Business Line) Type Definitions
 * 
 * Defines the available business verticals in the system.
 * Used across backend and frontend for consistent vertical handling.
 */

export enum Vertical {
    ISPRAVA = 'isprava',
    LOHONO_STAYS = 'lohono_stays',
    THE_CHAPTER = 'the_chapter',
    SOLENE = 'solene',
}

/**
 * Default vertical when none is specified
 */
export const DEFAULT_VERTICAL = Vertical.ISPRAVA;

/**
 * Human-readable display names for each vertical
 */
export const VERTICAL_DISPLAY_NAMES: Record<Vertical, string> = {
    [Vertical.ISPRAVA]: 'Isprava',
    [Vertical.LOHONO_STAYS]: 'Lohono Stays',
    [Vertical.THE_CHAPTER]: 'The Chapter',
    [Vertical.SOLENE]: 'Solene',
};

/**
 * Array of all available verticals (useful for dropdowns/iteration)
 */
export const ALL_VERTICALS = Object.values(Vertical);

/**
 * Type guard to check if a string is a valid vertical
 */
export function isValidVertical(value: unknown): value is Vertical {
    return typeof value === 'string' && ALL_VERTICALS.includes(value as Vertical);
}

/**
 * Aliases that map informal/partial names to canonical vertical values.
 * Used to normalise inputs before validation.
 */
const VERTICAL_ALIASES: Record<string, Vertical> = {
    'chapter': Vertical.THE_CHAPTER,
    'the chapter': Vertical.THE_CHAPTER,
    'lohono': Vertical.LOHONO_STAYS,
    'lohono stays': Vertical.LOHONO_STAYS,
};

/**
 * Normalise a raw string to a canonical Vertical value, applying aliases.
 */
export function normalizeVertical(value: unknown): Vertical | undefined {
    if (typeof value !== 'string') return undefined;
    const lower = value.trim().toLowerCase();
    if (VERTICAL_ALIASES[lower]) return VERTICAL_ALIASES[lower];
    if (isValidVertical(value)) return value;
    return undefined;
}

/**
 * Get a valid vertical or return the default
 * Useful for handling optional vertical parameters
 */
export function getVerticalOrDefault(value: unknown): Vertical {
    return normalizeVertical(value) ?? DEFAULT_VERTICAL;
}

/**
 * Get display name for a vertical
 */
export function getVerticalDisplayName(vertical: Vertical): string {
    return VERTICAL_DISPLAY_NAMES[vertical];
}
