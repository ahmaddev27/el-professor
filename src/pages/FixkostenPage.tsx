import React from 'react';
import FixedCostsManagement from '../components/FixedCostsManagement';

const FixkostenPage: React.FC = () => {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Fixkosten</h2>
      <FixedCostsManagement />
    </div>
  );
};

export default FixkostenPage;
