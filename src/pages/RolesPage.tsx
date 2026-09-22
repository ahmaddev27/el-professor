import React from 'react';
import RolesManagement from '../components/RolesManagement';

// AppLayout already pads the page; the screen draws its own header (phase 5).
const RolesPage: React.FC = () => {
  return <RolesManagement />;
};

export default RolesPage;
