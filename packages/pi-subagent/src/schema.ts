import Type from "typebox";

/** A plain `enum` keyword, which every provider accepts, instead of TypeBox's union of literals. */
export function stringEnum<const T extends readonly string[]>(
    values: T,
    options: { description?: string } = {},
) {
    return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
