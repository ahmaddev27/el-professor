import React, { useRef } from 'react';
import { Printer } from 'lucide-react';

const DruckenPage: React.FC = () => {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const handlePrint = () => {
    if (iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.print();
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white border-b border-gray-200 px-4 lg:px-8 py-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center space-x-3">
          <Printer className="w-6 h-6" />
          <span>Stundenzettel</span>
        </h1>
        <button
          onClick={handlePrint}
          className="flex items-center space-x-2 bg-blue-600 text-white px-6 py-2 rounded-md hover:bg-blue-700 transition-colors"
        >
          <Printer className="w-5 h-5" />
          <span>Drucken</span>
        </button>
      </div>

      <div className="flex-1 bg-gray-100">
        <iframe
          ref={iframeRef}
          src="/documents/Stundenzettel.pdf"
          className="w-full h-full border-0"
          title="Stundenzettel PDF"
        />
      </div>
    </div>
  );
};

export default DruckenPage;
