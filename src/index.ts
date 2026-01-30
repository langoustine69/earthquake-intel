import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

// === USGS Earthquake API Base URLs ===
const USGS_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

// === Helper: Fetch JSON from USGS ===
async function fetchUSGS(endpoint: string) {
  const response = await fetch(`${USGS_BASE}/${endpoint}`);
  if (!response.ok) throw new Error(`USGS API error: ${response.status}`);
  return response.json();
}

// === Helper: Calculate distance between two coordinates (Haversine) ===
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// === Helper: Parse earthquake features ===
function parseQuakes(features: any[]) {
  return features.map((f: any) => ({
    id: f.id,
    magnitude: f.properties.mag,
    place: f.properties.place,
    time: new Date(f.properties.time).toISOString(),
    depth: f.geometry.coordinates[2],
    coordinates: {
      latitude: f.geometry.coordinates[1],
      longitude: f.geometry.coordinates[0],
    },
    tsunami: f.properties.tsunami === 1,
    alert: f.properties.alert,
    felt: f.properties.felt,
    significance: f.properties.sig,
    url: f.properties.url,
  }));
}

// === Create Agent ===
const agent = await createAgent({
  name: 'earthquake-intel',
  version: '1.0.0',
  description: 'Real-time earthquake intelligence from USGS. Get global seismic activity, nearby earthquakes, significant events, and regional analysis.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === FREE ENDPOINT: Global Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free global earthquake summary - try before you buy',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const [hourData, dayData, weekData] = await Promise.all([
      fetchUSGS('all_hour.geojson'),
      fetchUSGS('4.5_day.geojson'),
      fetchUSGS('significant_week.geojson'),
    ]);

    return {
      output: {
        summary: {
          pastHour: {
            count: hourData.metadata.count,
            description: 'All earthquakes in the past hour',
          },
          significant24h: {
            count: dayData.metadata.count,
            description: 'Magnitude 4.5+ in the past 24 hours',
          },
          significantWeek: {
            count: weekData.metadata.count,
            description: 'Significant earthquakes in the past week',
          },
        },
        latestSignificant: weekData.features.length > 0 ? {
          magnitude: weekData.features[0].properties.mag,
          place: weekData.features[0].properties.place,
          time: new Date(weekData.features[0].properties.time).toISOString(),
        } : null,
        dataSource: 'USGS Earthquake Hazards Program (live)',
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 1: Recent Earthquakes ($0.001) ===
addEntrypoint({
  key: 'recent',
  description: 'Latest earthquakes in the past hour worldwide',
  input: z.object({
    limit: z.number().optional().default(20),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const data = await fetchUSGS('all_hour.geojson');
    const quakes = parseQuakes(data.features.slice(0, ctx.input.limit));

    return {
      output: {
        timeframe: 'past hour',
        totalCount: data.metadata.count,
        returned: quakes.length,
        earthquakes: quakes,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 2: Significant Earthquakes ($0.002) ===
addEntrypoint({
  key: 'significant',
  description: 'Significant earthquakes from the past week with alerts and impact data',
  input: z.object({
    limit: z.number().optional().default(10),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const data = await fetchUSGS('significant_week.geojson');
    const quakes = parseQuakes(data.features.slice(0, ctx.input.limit));

    return {
      output: {
        timeframe: 'past 7 days',
        totalSignificant: data.metadata.count,
        returned: quakes.length,
        earthquakes: quakes,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 3: Nearby Earthquakes ($0.002) ===
addEntrypoint({
  key: 'nearby',
  description: 'Find earthquakes within a radius of a location',
  input: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    radiusKm: z.number().optional().default(500),
    minMagnitude: z.number().optional().default(2.5),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { latitude, longitude, radiusKm, minMagnitude } = ctx.input;
    
    // Fetch day's earthquakes with minimum magnitude
    const endpoint = minMagnitude >= 4.5 ? '4.5_day.geojson' : 
                     minMagnitude >= 2.5 ? '2.5_day.geojson' : 
                     '1.0_day.geojson';
    
    const data = await fetchUSGS(endpoint);
    
    // Filter by distance
    const nearbyQuakes = data.features
      .filter((f: any) => {
        const qLat = f.geometry.coordinates[1];
        const qLon = f.geometry.coordinates[0];
        const distance = haversineDistance(latitude, longitude, qLat, qLon);
        return distance <= radiusKm;
      })
      .map((f: any) => {
        const qLat = f.geometry.coordinates[1];
        const qLon = f.geometry.coordinates[0];
        return {
          ...parseQuakes([f])[0],
          distanceKm: Math.round(haversineDistance(latitude, longitude, qLat, qLon)),
        };
      })
      .sort((a: any, b: any) => a.distanceKm - b.distanceKm);

    return {
      output: {
        searchCenter: { latitude, longitude },
        radiusKm,
        minMagnitude,
        timeframe: 'past 24 hours',
        found: nearbyQuakes.length,
        earthquakes: nearbyQuakes,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 4: Filter by Magnitude ($0.002) ===
addEntrypoint({
  key: 'magnitude',
  description: 'Get earthquakes filtered by magnitude threshold',
  input: z.object({
    minMagnitude: z.enum(['1.0', '2.5', '4.5']),
    timeframe: z.enum(['hour', 'day', 'week', 'month']).optional().default('day'),
    limit: z.number().optional().default(25),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { minMagnitude, timeframe, limit } = ctx.input;
    const endpoint = `${minMagnitude}_${timeframe}.geojson`;
    
    const data = await fetchUSGS(endpoint);
    const quakes = parseQuakes(data.features.slice(0, limit));

    return {
      output: {
        filter: {
          minMagnitude: parseFloat(minMagnitude),
          timeframe,
        },
        totalCount: data.metadata.count,
        returned: quakes.length,
        earthquakes: quakes,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 5: Regional Report ($0.005) ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive seismic activity report combining multiple data sources',
  input: z.object({
    region: z.enum(['global', 'pacific', 'americas', 'asia', 'europe']).optional().default('global'),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    // Fetch multiple data sources
    const [hourAll, day45, weekSig, monthAll] = await Promise.all([
      fetchUSGS('all_hour.geojson'),
      fetchUSGS('4.5_day.geojson'),
      fetchUSGS('significant_week.geojson'),
      fetchUSGS('all_month.geojson'),
    ]);

    // Regional filtering bounds
    const regionBounds: Record<string, { latMin: number; latMax: number; lonMin: number; lonMax: number }> = {
      global: { latMin: -90, latMax: 90, lonMin: -180, lonMax: 180 },
      pacific: { latMin: -60, latMax: 60, lonMin: 100, lonMax: -100 },
      americas: { latMin: -60, latMax: 70, lonMin: -170, lonMax: -30 },
      asia: { latMin: -10, latMax: 60, lonMin: 60, lonMax: 150 },
      europe: { latMin: 35, latMax: 72, lonMin: -25, lonMax: 45 },
    };

    const bounds = regionBounds[ctx.input.region];
    
    const filterByRegion = (features: any[]) => {
      if (ctx.input.region === 'global') return features;
      return features.filter((f: any) => {
        const lat = f.geometry.coordinates[1];
        const lon = f.geometry.coordinates[0];
        // Handle Pacific crossing dateline
        if (ctx.input.region === 'pacific') {
          return lat >= bounds.latMin && lat <= bounds.latMax && 
                 (lon >= bounds.lonMin || lon <= bounds.lonMax);
        }
        return lat >= bounds.latMin && lat <= bounds.latMax &&
               lon >= bounds.lonMin && lon <= bounds.lonMax;
      });
    };

    const regionalHour = filterByRegion(hourAll.features);
    const regional45 = filterByRegion(day45.features);
    const regionalSig = filterByRegion(weekSig.features);
    const regionalMonth = filterByRegion(monthAll.features);

    // Calculate statistics
    const magnitudes = regionalMonth.map((f: any) => f.properties.mag).filter((m: any) => m !== null);
    const avgMagnitude = magnitudes.length > 0 
      ? (magnitudes.reduce((a: number, b: number) => a + b, 0) / magnitudes.length).toFixed(2)
      : null;
    const maxMagnitude = magnitudes.length > 0 ? Math.max(...magnitudes) : null;

    // Find most active area
    const places = regionalMonth.map((f: any) => f.properties.place).filter(Boolean);
    const placeCount: Record<string, number> = {};
    places.forEach((p: string) => {
      const region = p.split(',').pop()?.trim() || p;
      placeCount[region] = (placeCount[region] || 0) + 1;
    });
    const mostActive = Object.entries(placeCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([area, count]) => ({ area, count }));

    return {
      output: {
        region: ctx.input.region,
        statistics: {
          pastHour: regionalHour.length,
          magnitude45_24h: regional45.length,
          significantWeek: regionalSig.length,
          totalMonth: regionalMonth.length,
          averageMagnitude: avgMagnitude,
          maxMagnitude,
        },
        mostActiveAreas: mostActive,
        recentSignificant: parseQuakes(regionalSig.slice(0, 5)),
        latestLarge: parseQuakes(regional45.slice(0, 5)),
        insights: {
          activity: regionalHour.length > 10 ? 'HIGH' : regionalHour.length > 5 ? 'MODERATE' : 'LOW',
          trend: regionalMonth.length > 1000 ? 'Above average seismic activity' : 'Normal activity levels',
        },
        dataSource: 'USGS Earthquake Hazards Program (aggregated from 4 feeds)',
        generatedAt: new Date().toISOString(),
      },
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🌍 Earthquake Intel Agent running on port ${port}`);

export default { port, fetch: app.fetch };
