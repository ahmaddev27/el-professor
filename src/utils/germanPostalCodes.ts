const cityCache = new Map<string, string>();

export async function getCityFromPostalCode(postalCode: string): Promise<string | null> {
  const cleanCode = postalCode.trim();

  if (cityCache.has(cleanCode)) {
    return cityCache.get(cleanCode) || null;
  }

  try {
    const response = await fetch(`https://api.zippopotam.us/de/${cleanCode}`);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (data.places && data.places.length > 0) {
      const city = data.places[0]['place name'];
      cityCache.set(cleanCode, city);
      return city;
    }

    return null;
  } catch (error) {
    console.error('Error fetching city for postal code:', error);
    return null;
  }
}

export function isValidGermanPostalCode(postalCode: string): boolean {
  const cleanCode = postalCode.trim();
  return /^\d{5}$/.test(cleanCode);
}
