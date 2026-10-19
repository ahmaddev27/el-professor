import { describe, expect, it } from 'vitest';
import { readOdometer } from './odometerRead';

describe('readOdometer', () => {
  it('reads a clean cluster: odometer and range', () => {
    expect(readOdometer(['25382 km', '277 km', '14 °C', '4:24'])).toEqual({ odometerKm: 25382, rangeKm: 277 });
  });

  it('lets the largest bare km win', () => {
    expect(readOdometer(['120 km', '98765 km', '25382 km']).odometerKm).toBe(98765);
  });

  it('refuses a four-digit number rather than guessing', () => {
    expect(readOdometer(['9999 km'])).toEqual({ odometerKm: null, rangeKm: null, problem: 'too_small' });
  });

  it('keeps a small range even when the odometer is refused', () => {
    const reading = readOdometer(['277 km']);
    expect(reading.odometerKm).toBeNull();
    expect(reading.rangeKm).toBe(277);
    expect(reading.problem).toBe('too_small');
  });

  it('refuses when there is no km at all, and does not fall back to the largest number', () => {
    expect(readOdometer(['25382', '14 °C', '4:24'])).toEqual({ odometerKm: null, rangeKm: null, problem: 'no_km_value' });
  });

  it('refuses when there is no text', () => {
    expect(readOdometer([])).toEqual({ odometerKm: null, rangeKm: null, problem: 'no_text' });
    expect(readOdometer(['  ', ''])).toEqual({ odometerKm: null, rangeKm: null, problem: 'no_text' });
  });

  it('does not take a speed or a consumption for the odometer', () => {
    expect(readOdometer(['120000 km/h', '4.6 L/100km']).problem).toBe('no_km_value');
  });

  it('reads km with a space and any case', () => {
    expect(readOdometer(['25382 KM']).odometerKm).toBe(25382);
    expect(readOdometer(['25382km']).odometerKm).toBe(25382);
  });

  it('never returns 0 for what it did not read', () => {
    const reading = readOdometer(['nothing here']);
    expect(reading.odometerKm).toBeNull();
    expect(reading.rangeKm).toBeNull();
  });
});
