import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

const agent = await createAgent({
  name: 'earthquake-intel',
  version: '1.0.0',
  description: 'Real-time earthquake intelligence from USGS. Track seismic activity worldwide, get alerts for regions, and assess earthquake risk for any location.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON from USGS ===
async function fetchJSON(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`USGS API error: ${response.status}`);
  return response.json();
}

// === HELPER: Format earthquake data ===
function formatQuake(feature: any) {
  const props = feature.properties;
  const coords = feature.geometry.coordinates;
  return {
    id: feature.id,
    magnitude: props.mag,
    magnitudeType: props.magType,
    place: props.place,
    time: new Date(props.time).toISOString(),
    updated: new Date(props.updated).toISOString(),
    coordinates: {
      longitude: coords[0],
      latitude: coords[1],
      depth: coords[2],
    },
    significance: props.sig,
    felt: props.felt,
    alert: props.alert,
    tsunami: props.tsunami === 1,
    url: props.url,
  };
}

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of recent significant seismic activity worldwide. Try before you buy!',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const [significant, recent] = await Promise.all([
      fetchJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson'),
      fetchJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson'),
    ]);

    return {
      output: {
        summary: {
          significantQuakesThisWeek: significant.metadata.count,
          magnitude45PlusToday: recent.metadata.count,
          largestThisWeek: significant.features.length > 0
            ? formatQuake(significant.features.reduce((max: any, f: any) => 
                f.properties.mag > max.properties.mag ? f : max, significant.features[0]))
            : null,
        },
        recentSignificant: significant.features.slice(0, 3).map(formatQuake),
        fetchedAt: new Date().toISOString(),
        dataSource: 'USGS Earthquake Hazards Program (live)',
        availableEndpoints: [
          'lookup - Get full details for any earthquake by ID ($0.001)',
          'search - Search by location, magnitude, timeframe ($0.002)',
          'top - Top earthquakes by magnitude or significance ($0.002)',
          'compare - Compare seismic activity across regions ($0.003)',
          'report - Full seismic risk report for any location ($0.005)',
        ],
      },
    };
  },
});

// === PAID ENDPOINT 1: Lookup ($0.001) ===
addEntrypoint({
  key: 'lookup',
  description: 'Get full details for a specific earthquake by its USGS event ID',
  input: z.object({
    eventId: z.string().describe('USGS earthquake event ID (e.g., us6000s5ba)'),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const data = await fetchJSON(
      `https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=${ctx.input.eventId}&format=geojson`
    );

    const props = data.properties;
    const coords = data.geometry.coordinates;

    return {
      output: {
        id: data.id,
        magnitude: props.mag,
        magnitudeType: props.magType,
        place: props.place,
        time: new Date(props.time).toISOString(),
        updated: new Date(props.updated).toISOString(),
        coordinates: {
          longitude: coords[0],
          latitude: coords[1],
          depthKm: coords[2],
        },
        significance: props.sig,
        felt: props.felt,
        communityIntensity: props.cdi,
        estimatedIntensity: props.mmi,
        alert: props.alert,
        tsunami: props.tsunami === 1,
        status: props.status,
        network: props.net,
        sources: props.sources,
        detailTypes: props.types,
        url: props.url,
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 2: Search ($0.002) ===
addEntrypoint({
  key: 'search',
  description: 'Search earthquakes by location (lat/lon + radius), magnitude range, and time period',
  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Center latitude'),
    longitude: z.number().min(-180).max(180).describe('Center longitude'),
    radiusKm: z.number().min(1).max(20000).optional().default(500).describe('Search radius in km'),
    minMagnitude: z.number().min(0).max(10).optional().default(2.5).describe('Minimum magnitude'),
    maxMagnitude: z.number().min(0).max(10).optional().describe('Maximum magnitude'),
    daysBack: z.number().min(1).max(30).optional().default(7).describe('Days of history to search'),
    limit: z.number().min(1).max(100).optional().default(20).describe('Max results to return'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { latitude, longitude, radiusKm, minMagnitude, maxMagnitude, daysBack, limit } = ctx.input;
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    let url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
      `&starttime=${startDate.toISOString().split('T')[0]}` +
      `&endtime=${endDate.toISOString().split('T')[0]}` +
      `&latitude=${latitude}&longitude=${longitude}&maxradiuskm=${radiusKm}` +
      `&minmagnitude=${minMagnitude}&limit=${limit}&orderby=time`;

    if (maxMagnitude !== undefined) {
      url += `&maxmagnitude=${maxMagnitude}`;
    }

    const data = await fetchJSON(url);

    return {
      output: {
        query: { latitude, longitude, radiusKm, minMagnitude, maxMagnitude, daysBack },
        totalFound: data.metadata.count,
        earthquakes: data.features.map(formatQuake),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 3: Top ($0.002) ===
addEntrypoint({
  key: 'top',
  description: 'Get top earthquakes ranked by magnitude or significance over a time period',
  input: z.object({
    period: z.enum(['day', 'week', 'month']).optional().default('week').describe('Time period'),
    rankBy: z.enum(['magnitude', 'significance']).optional().default('magnitude').describe('Ranking metric'),
    minMagnitude: z.number().min(0).max(10).optional().default(4.5).describe('Minimum magnitude filter'),
    limit: z.number().min(1).max(50).optional().default(10).describe('Number of results'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { period, rankBy, minMagnitude, limit } = ctx.input;
    
    // Use pre-built feeds for efficiency
    const feedMap: Record<string, string> = {
      day: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
      week: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson',
      month: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_month.geojson',
    };

    const data = await fetchJSON(feedMap[period]);

    // Filter and sort
    let filtered = data.features.filter((f: any) => f.properties.mag >= minMagnitude);
    
    if (rankBy === 'magnitude') {
      filtered.sort((a: any, b: any) => b.properties.mag - a.properties.mag);
    } else {
      filtered.sort((a: any, b: any) => b.properties.sig - a.properties.sig);
    }

    const topQuakes = filtered.slice(0, limit);

    return {
      output: {
        period,
        rankBy,
        minMagnitude,
        totalFiltered: filtered.length,
        topEarthquakes: topQuakes.map((f: any, i: number) => ({
          rank: i + 1,
          ...formatQuake(f),
        })),
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 4: Compare ($0.003) ===
addEntrypoint({
  key: 'compare',
  description: 'Compare seismic activity between multiple regions over the past week',
  input: z.object({
    regions: z.array(z.object({
      name: z.string().describe('Region name/label'),
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusKm: z.number().min(10).max(5000).optional().default(500),
    })).min(2).max(5).describe('Regions to compare (2-5)'),
    minMagnitude: z.number().min(0).max(10).optional().default(2.5),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const { regions, minMagnitude } = ctx.input;
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);

    const results = await Promise.all(regions.map(async (region) => {
      const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
        `&starttime=${startDate.toISOString().split('T')[0]}` +
        `&endtime=${endDate.toISOString().split('T')[0]}` +
        `&latitude=${region.latitude}&longitude=${region.longitude}&maxradiuskm=${region.radiusKm}` +
        `&minmagnitude=${minMagnitude}`;

      const data = await fetchJSON(url);
      
      const magnitudes = data.features.map((f: any) => f.properties.mag);
      const avgMag = magnitudes.length > 0 
        ? magnitudes.reduce((a: number, b: number) => a + b, 0) / magnitudes.length 
        : 0;
      const maxMag = magnitudes.length > 0 ? Math.max(...magnitudes) : 0;

      return {
        region: region.name,
        coordinates: { latitude: region.latitude, longitude: region.longitude },
        radiusKm: region.radiusKm,
        stats: {
          totalQuakes: data.metadata.count,
          averageMagnitude: Number(avgMag.toFixed(2)),
          maxMagnitude: maxMag,
          quakesAbove4: magnitudes.filter((m: number) => m >= 4).length,
          quakesAbove5: magnitudes.filter((m: number) => m >= 5).length,
        },
        topQuake: data.features.length > 0 
          ? formatQuake(data.features.reduce((max: any, f: any) => 
              f.properties.mag > max.properties.mag ? f : max, data.features[0]))
          : null,
      };
    }));

    // Rank regions by activity
    const ranked = [...results].sort((a, b) => b.stats.totalQuakes - a.stats.totalQuakes);

    return {
      output: {
        periodDays: 7,
        minMagnitude,
        comparison: results,
        ranking: {
          mostActive: ranked[0].region,
          leastActive: ranked[ranked.length - 1].region,
          byTotalQuakes: ranked.map(r => ({ region: r.region, count: r.stats.totalQuakes })),
        },
        fetchedAt: new Date().toISOString(),
      },
    };
  },
});

// === PAID ENDPOINT 5: Report ($0.005) ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive seismic risk report for a location - includes history, recent activity, and risk assessment',
  input: z.object({
    latitude: z.number().min(-90).max(90).describe('Location latitude'),
    longitude: z.number().min(-180).max(180).describe('Location longitude'),
    locationName: z.string().optional().describe('Optional name for the location'),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const { latitude, longitude, locationName } = ctx.input;
    
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Fetch data at multiple radii and timeframes
    const [nearby50km, nearby250km, nearby500km, significant] = await Promise.all([
      // Very close (50km) - last month
      fetchJSON(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
        `&starttime=${monthAgo.toISOString().split('T')[0]}` +
        `&latitude=${latitude}&longitude=${longitude}&maxradiuskm=50&minmagnitude=1`),
      // Moderate distance (250km) - last month
      fetchJSON(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
        `&starttime=${monthAgo.toISOString().split('T')[0]}` +
        `&latitude=${latitude}&longitude=${longitude}&maxradiuskm=250&minmagnitude=2.5`),
      // Regional (500km) - last week, M4+
      fetchJSON(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
        `&starttime=${weekAgo.toISOString().split('T')[0]}` +
        `&latitude=${latitude}&longitude=${longitude}&maxradiuskm=500&minmagnitude=4`),
      // Significant quakes globally (for context)
      fetchJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson'),
    ]);

    // Calculate risk indicators
    const nearbyMags = nearby50km.features.map((f: any) => f.properties.mag);
    const regionalMags = nearby250km.features.map((f: any) => f.properties.mag);
    
    const maxNearby = nearbyMags.length > 0 ? Math.max(...nearbyMags) : 0;
    const avgNearby = nearbyMags.length > 0 
      ? nearbyMags.reduce((a: number, b: number) => a + b, 0) / nearbyMags.length 
      : 0;

    // Simple risk level calculation
    let riskLevel: 'low' | 'moderate' | 'elevated' | 'high' = 'low';
    let riskScore = 0;
    
    if (nearby50km.metadata.count > 0) riskScore += nearby50km.metadata.count * 2;
    if (nearby250km.metadata.count > 10) riskScore += 10;
    if (maxNearby >= 4) riskScore += 15;
    if (maxNearby >= 5) riskScore += 25;
    if (nearby500km.metadata.count > 5) riskScore += 5;

    if (riskScore >= 50) riskLevel = 'high';
    else if (riskScore >= 25) riskLevel = 'elevated';
    else if (riskScore >= 10) riskLevel = 'moderate';

    return {
      output: {
        location: {
          name: locationName || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`,
          latitude,
          longitude,
        },
        riskAssessment: {
          level: riskLevel,
          score: riskScore,
          factors: [
            `${nearby50km.metadata.count} quakes within 50km (30 days)`,
            `${nearby250km.metadata.count} quakes M2.5+ within 250km (30 days)`,
            `${nearby500km.metadata.count} quakes M4+ within 500km (7 days)`,
            maxNearby > 0 ? `Largest nearby: M${maxNearby.toFixed(1)}` : 'No significant nearby activity',
          ],
        },
        recentActivity: {
          within50km: {
            count: nearby50km.metadata.count,
            period: '30 days',
            maxMagnitude: maxNearby,
            avgMagnitude: Number(avgNearby.toFixed(2)),
            quakes: nearby50km.features.slice(0, 5).map(formatQuake),
          },
          within250km: {
            count: nearby250km.metadata.count,
            period: '30 days',
            quakes: nearby250km.features.slice(0, 5).map(formatQuake),
          },
          within500km: {
            count: nearby500km.metadata.count,
            period: '7 days',
            minMagnitude: 4,
            quakes: nearby500km.features.slice(0, 5).map(formatQuake),
          },
        },
        globalContext: {
          significantQuakesThisWeek: significant.metadata.count,
          nearestSignificant: significant.features.length > 0
            ? formatQuake(significant.features[0])
            : null,
        },
        generatedAt: new Date().toISOString(),
        dataSource: 'USGS Earthquake Hazards Program',
        disclaimer: 'This is an automated analysis based on historical data. For official risk assessments, consult local geological authorities.',
      },
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`🌍 Earthquake Intel Agent running on port ${port}`);

export default { port, fetch: app.fetch };
