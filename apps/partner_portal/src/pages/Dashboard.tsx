import React, { useState, useEffect, useCallback } from 'react';
import { partnerDashboard, partnerUsage, partnerEarnings, partnerCommission } from '../api/partner';
import { useNavigate } from 'react-router-dom';

export const PartnerDashboard: React.FC = () => {
  const [data, setData] = useState<PartnerDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [dashboard, usage, earnings, commission] = await Promise.all([
        partnerDashboard(),
        partnerUsage({ page: 1, limit: 10 }),
        partnerEarnings({ page: 1, limit: 10 }),
        partnerCommission(),
      ]);
      setData({ dashboard, usage, earnings, commission });
    } catch (e: any) {
      setError(e.response?.data?.message || e.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleRefresh = useCallback(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return <div>Loading partner dashboard...</div>;
  }

  if (error) {
    return <div>Error: {error}<button onClick={handleRefresh}>Retry</button></div>;
  }

  if (!data) {
    return <div>No data available</div>;
  }

  const { dashboard, usage, earnings, commission } = data;

  return (
    <div className="partner-dashboard">
      <h2>Partner Dashboard</h2>

      {/* Usage section */}
      <section className="usage-section">
        <h3>Ride Usage</h3>
        <p>Total Rides: {usage.total}</p>
        <ul>
          {usage.rides.map((ride: any) => (
            <li key={ride.id}>
              {ride.status} {ride.promo_code ? ` (Promo: ${ride.promo_code})` : ''}
            </li>
          ))}
        </ul>
      </section>

      {/* Earnings section */}
      <section className="earnings-section">
        <h3>Earnings</h3>
        <p>Total Earnings: ${(earnings.total_earnings_cents / 100).toFixed(2)}</p>
        <p>Total Rides: {earnings.total_rides}</p>
        <ul>
          {earnings.recent_earnings.map((earning: any) => (
            <li key={earning.ride_id}>
              Ride {earning.ride_id}: ${(earning.final_payment_cents / 100).toFixed(2)} 
              {(earning.promo_code ? `Promo: ${earning.promo_code}` : '')}
            </li>
          ))}
        </ul>
      </section>

      {/* Commission section */}
      <section className="commission-section">
        <h3>Commission</h3>
        <p>Commission Rate: {commission.commission_rate}%</p>
        <p>Commission Type: {commission.commission_type}</p>
        <p>Lifetime Earnings: ${(commission.lifetime_earnings_cents / 100).toFixed(2)}</p>
        <p>Pending: ${(commission.pending_earnings_cents / 100).toFixed(2)}</p>
        <p>Paid: ${(commission.paid_earnings_cents / 100).toFixed(2)}</p>
      </section>
    </div>
  );
};