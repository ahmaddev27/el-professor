import React from 'react';
import FixedCostsManagement from '../components/FixedCostsManagement';

// The screen draws its own header since phase 5; the page's second
// "Fixkosten" title above it is gone (audit finding 10).
const FixkostenPage: React.FC = () => {
  return <FixedCostsManagement />;
};

export default FixkostenPage;
