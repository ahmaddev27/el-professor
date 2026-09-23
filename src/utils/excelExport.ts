import * as XLSX from 'xlsx';
import { Receipt, Income, SalaryCalculation } from '../types/receipt';

export const exportToExcel = (receipts: Receipt[], initialBalance: number = 0, isFiltered: boolean = false) => {
  // Create workbook with enhanced properties
  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: "El-Professor - Professional Financial Report",
    Subject: "Comprehensive Financial Analysis and Receipt Management",
    Author: "El-Professor Management System",
    CreatedDate: new Date(),
    Company: "El-Professor Solutions"
  };
  
  // Calculate comprehensive statistics
  const totalIncome = receipts.reduce((sum, receipt) => sum + receipt.income, 0);
  const totalExpense = receipts.reduce((sum, receipt) => sum + receipt.expense, 0);
  const netResult = totalIncome - totalExpense;
  const finalBalance = receipts.length > 0 ? receipts[receipts.length - 1].balance : initialBalance;
  
  // Sort receipts chronologically
  const sortedReceipts = [...receipts].sort((a, b) => 
    new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  
  // Get unique drivers for statistics
  const uniqueDrivers = [...new Set(receipts.map(r => r.driverName))];
  const avgTransactionValue = receipts.length > 0 ? (totalIncome + totalExpense) / receipts.length : 0;
  
  // Create professional data structure with proper table formatting
  const excelData = [
    // MAIN HEADER SECTION
    ['EL-PROFESSOR', '', '', 'PROFESSIONAL FINANCIAL REPORT', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],

    // EXECUTIVE SUMMARY TABLE
    ['EXECUTIVE SUMMARY', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['Metric', 'Value', 'Status', '', 'Period Info', 'Details', '', '', '', '', ''],
    ['Report Date', new Date().toLocaleDateString('de-DE'), 'Current', '', 'Total Receipts', sortedReceipts.length.toString(), '', '', '', '', ''],
    ['Period Range', sortedReceipts.length > 0 ? `${new Date(sortedReceipts[0].date).toLocaleDateString('de-DE')} - ${new Date(sortedReceipts[sortedReceipts.length - 1].date).toLocaleDateString('de-DE')}` : 'No Data', 'Active', '', 'Active Drivers', uniqueDrivers.length.toString(), '', '', '', '', ''],
    ['Filter Applied', isFiltered ? 'YES' : 'NO', isFiltered ? 'Filtered' : 'Complete', '', 'Avg Transaction', avgTransactionValue.toFixed(2) + ' EUR', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],
    
    // FINANCIAL DASHBOARD TABLE
    ['FINANCIAL DASHBOARD', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['Financial Position', 'Amount (EUR)', 'Status', 'Trend', '', 'Key Metrics', 'Value', 'Performance', '', '', ''],
    ['Opening Balance', initialBalance.toFixed(2), initialBalance >= 0 ? 'POSITIVE' : 'NEGATIVE', initialBalance >= 0 ? 'STABLE' : 'RISK', '', 'Total Volume', (totalIncome + totalExpense).toFixed(2), 'EUR', '', '', ''],
    ['Total Income', totalIncome.toFixed(2), totalIncome > 0 ? 'REVENUE' : 'NONE', totalIncome > 0 ? 'ACTIVE' : 'INACTIVE', '', 'Net Result', netResult.toFixed(2), netResult >= 0 ? 'PROFIT' : 'LOSS', '', '', ''],
    ['Total Expenses', totalExpense.toFixed(2), totalExpense > 0 ? 'COSTS' : 'NONE', totalExpense > 0 ? 'ACTIVE' : 'INACTIVE', '', 'ROI Percentage', totalExpense > 0 ? ((netResult / totalExpense) * 100).toFixed(1) + '%' : 'N/A', '', '', '', ''],
    ['Net Position', netResult.toFixed(2), netResult >= 0 ? 'PROFIT' : 'LOSS', netResult >= 0 ? 'GROWTH' : 'DECLINE', '', 'Liquidity Status', finalBalance >= 0 ? 'HEALTHY' : 'CRITICAL', finalBalance >= 0 ? 'SECURE' : 'ALERT', '', '', ''],
    ['Closing Balance', finalBalance.toFixed(2), finalBalance >= 0 ? 'POSITIVE' : 'NEGATIVE', finalBalance >= 0 ? 'STRONG' : 'WEAK', '', 'Business Trend', netResult >= 0 ? 'UPWARD' : 'DOWNWARD', netResult >= 0 ? 'EXPANDING' : 'CONTRACTING', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],
    
    // DRIVER PERFORMANCE TABLE
    ['DRIVER PERFORMANCE ANALYSIS', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['Driver Name', 'Receipt Count', 'Income (EUR)', 'Expenses (EUR)', 'Net Amount (EUR)', 'Performance', 'Efficiency', '', '', '', ''],
    
    // Driver statistics with enhanced metrics
    ...uniqueDrivers.map(driver => {
      const driverReceipts = receipts.filter(r => r.driverName === driver);
      const driverIncome = driverReceipts.reduce((sum, r) => sum + r.income, 0);
      const driverExpense = driverReceipts.reduce((sum, r) => sum + r.expense, 0);
      const driverNet = driverIncome - driverExpense;
      const efficiency = driverReceipts.length > 0 ? (driverNet / driverReceipts.length).toFixed(2) : '0.00';
      return [driver, driverReceipts.length.toString(), driverIncome.toFixed(2), driverExpense.toFixed(2), driverNet.toFixed(2), driverNet >= 0 ? 'PROFITABLE' : 'LOSS', efficiency + ' EUR/Receipt', '', '', '', ''];
    }),
    
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['DRIVER TOTALS', uniqueDrivers.length.toString() + ' Drivers', totalIncome.toFixed(2), totalExpense.toFixed(2), netResult.toFixed(2), netResult >= 0 ? 'OVERALL PROFIT' : 'OVERALL LOSS', avgTransactionValue.toFixed(2) + ' EUR Avg', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],
    
    // DETAILED TRANSACTIONS TABLE
    ['DETAILED TRANSACTION RECORDS', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['Receipt No.', 'Date', 'Driver', 'Description', 'Postal Code', 'City', 'Income (EUR)', 'Expenses (EUR)', 'Balance (EUR)', 'Type', 'Status'],

    // Transaction data with enhanced formatting
    ...sortedReceipts.map((receipt, index) => {
      const type = receipt.income > 0 ? 'INCOME' :
                   receipt.expense > 0 ? 'EXPENSE' : 'NEUTRAL';
      const status = receipt.balance >= 0 ? 'POSITIVE' : 'NEGATIVE';
      return [
        receipt.receiptNumber,
        new Date(receipt.date).toLocaleDateString('de-DE'),
        receipt.driverName,
        receipt.description,
        receipt.postalCode || '',
        receipt.city || '',
        receipt.income > 0 ? receipt.income.toFixed(2) : '',
        receipt.expense > 0 ? receipt.expense.toFixed(2) : '',
        receipt.balance.toFixed(2),
        type,
        status
      ];
    }),
    
    // SUMMARY AND TOTALS TABLE
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['PERIOD SUMMARY', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['Summary Item', 'Count', 'Amount (EUR)', 'Percentage', '', 'Final Status', 'Assessment', '', '', '', ''],
    ['Income Transactions', receipts.filter(r => r.income > 0).length.toString(), totalIncome.toFixed(2), totalIncome > 0 ? ((totalIncome / (totalIncome + totalExpense)) * 100).toFixed(1) + '%' : '0%', '', 'Revenue Stream', totalIncome > 0 ? 'ACTIVE' : 'INACTIVE', '', '', '', ''],
    ['Expense Transactions', receipts.filter(r => r.expense > 0).length.toString(), totalExpense.toFixed(2), totalExpense > 0 ? ((totalExpense / (totalIncome + totalExpense)) * 100).toFixed(1) + '%' : '0%', '', 'Cost Management', totalExpense > 0 ? 'ACTIVE' : 'INACTIVE', '', '', '', ''],
    ['Net Business Result', receipts.length.toString(), netResult.toFixed(2), '100%', '', 'Overall Performance', netResult >= 0 ? 'SUCCESSFUL' : 'NEEDS ATTENTION', '', '', '', ''],
    ['Final Balance Position', '1', finalBalance.toFixed(2), finalBalance >= 0 ? 'POSITIVE' : 'NEGATIVE', '', 'Financial Health', finalBalance >= 0 ? 'EXCELLENT' : 'REQUIRES REVIEW', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', ''],
    
    // FOOTER SECTION
    ['', '', '', '', '', '', '', '', '', '', ''],
    ['El-Professor Professional Financial Report', '', '', `Generated: ${new Date().toLocaleString('de-DE')}`, '', '', '', '', '', '', ''],
    ['This document contains confidential financial information', '', '', 'Authorized Personnel Only', '', '', '', '', '', '', '']
  ];

  // Create worksheet
  const ws = XLSX.utils.aoa_to_sheet(excelData);
  
  // ENHANCED COLUMN CONFIGURATION
  ws['!cols'] = [
    { wch: 20 },  // Column A - Labels/Names
    { wch: 15 },  // Column B - Values/Counts
    { wch: 15 },  // Column C - Amounts
    { wch: 25 },  // Column D - Descriptions/Status
    { wch: 12 },  // Column E - Postal Code
    { wch: 20 },  // Column F - City
    { wch: 15 },  // Column G - Income
    { wch: 15 },  // Column H - Expenses
    { wch: 15 },  // Column I - Balance
    { wch: 12 },  // Column J - Type
    { wch: 12 }   // Column K - Status
  ];

  // Calculate dynamic section positions
  const executiveSummaryStart = 2;
  const executiveSummaryHeaderRow = 4;
  const executiveSummaryDataStart = 5;
  const executiveSummaryDataEnd = 7;
  
  const financialDashboardStart = executiveSummaryDataEnd + 3;
  const financialDashboardHeaderRow = financialDashboardStart + 2;
  const financialDashboardDataStart = financialDashboardHeaderRow + 1;
  const financialDashboardDataEnd = financialDashboardDataStart + 4;
  
  const driverPerformanceStart = financialDashboardDataEnd + 3;
  const driverPerformanceHeaderRow = driverPerformanceStart + 2;
  const driverPerformanceDataStart = driverPerformanceHeaderRow + 1;
  const driverPerformanceDataEnd = driverPerformanceDataStart + uniqueDrivers.length;
  const driverTotalsRow = driverPerformanceDataEnd + 1;
  
  const transactionTableStart = driverTotalsRow + 4;
  const transactionTableHeaderRow = transactionTableStart + 2;
  const transactionTableDataStart = transactionTableHeaderRow + 1;
  const transactionTableDataEnd = transactionTableDataStart + sortedReceipts.length - 1;
  
  const summaryTableStart = transactionTableDataEnd + 4;
  const summaryTableHeaderRow = summaryTableStart + 2;
  const summaryTableDataStart = summaryTableHeaderRow + 1;
  const summaryTableDataEnd = summaryTableDataStart + 3;

  // Get worksheet range
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  
  // PROFESSIONAL STYLING WITH COMPREHENSIVE BORDERS AND TABLE FORMATTING
  for (let R = range.s.r; R <= range.e.r; ++R) {
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cell_address = XLSX.utils.encode_cell({ c: C, r: R });
      if (!ws[cell_address]) continue;
      
      const cellValue = ws[cell_address].v;
      
      // MAIN HEADER STYLING
      if (R === 0) {
        ws[cell_address].s = {
          font: { 
            bold: true, 
            size: 24, 
            color: { rgb: "FFFFFF" },
            name: "Calibri"
          },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "1E3A8A" } },
          border: {
            top: { style: "thick", color: { rgb: "000000" } },
            bottom: { style: "thick", color: { rgb: "000000" } },
            left: { style: "thick", color: { rgb: "000000" } },
            right: { style: "thick", color: { rgb: "000000" } }
          }
        };
      }
      
      // SECTION HEADERS
      if (cellValue && typeof cellValue === 'string' && 
          (cellValue.includes('EXECUTIVE SUMMARY') || 
           cellValue.includes('FINANCIAL DASHBOARD') || 
           cellValue.includes('DRIVER PERFORMANCE ANALYSIS') ||
           cellValue.includes('DETAILED TRANSACTION RECORDS') ||
           cellValue.includes('PERIOD SUMMARY'))) {
        ws[cell_address].s = {
          font: { 
            bold: true, 
            size: 16, 
            color: { rgb: "FFFFFF" },
            name: "Calibri"
          },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "059669" } },
          border: {
            top: { style: "thick", color: { rgb: "000000" } },
            bottom: { style: "thick", color: { rgb: "000000" } },
            left: { style: "thick", color: { rgb: "000000" } },
            right: { style: "thick", color: { rgb: "000000" } }
          }
        };
      }
      
      // EXECUTIVE SUMMARY TABLE
      if (R >= executiveSummaryHeaderRow && R <= executiveSummaryDataEnd && C <= 8) {
        const isHeaderRow = R === executiveSummaryHeaderRow;
        const isDataRow = R >= executiveSummaryDataStart && R <= executiveSummaryDataEnd;
        
        if (isHeaderRow) {
          ws[cell_address].s = {
            font: { bold: true, size: 12, color: { rgb: "FFFFFF" }, name: "Calibri" },
            alignment: { horizontal: "center", vertical: "center" },
            fill: { fgColor: { rgb: "1E40AF" } },
            border: {
              top: { style: "thick", color: { rgb: "000000" } },
              bottom: { style: "thick", color: { rgb: "000000" } },
              left: { style: "medium", color: { rgb: "000000" } },
              right: { style: "medium", color: { rgb: "000000" } }
            }
          };
        }
        
        if (isDataRow) {
          const isEvenRow = (R - executiveSummaryDataStart) % 2 === 0;
          ws[cell_address].s = {
            font: { size: 11, name: "Calibri" },
            alignment: { horizontal: "left", vertical: "center" },
            fill: { fgColor: { rgb: isEvenRow ? "EBF8FF" : "F0F9FF" } },
            border: {
              top: { style: "thin", color: { rgb: "000000" } },
              bottom: { style: "thin", color: { rgb: "000000" } },
              left: { style: "thin", color: { rgb: "000000" } },
              right: { style: "thin", color: { rgb: "000000" } }
            }
          };
        }
      }
      
      // FINANCIAL DASHBOARD TABLE
      if (R >= financialDashboardHeaderRow && R <= financialDashboardDataEnd && C <= 8) {
        const isHeaderRow = R === financialDashboardHeaderRow;
        const isDataRow = R >= financialDashboardDataStart && R <= financialDashboardDataEnd;
        
        if (isHeaderRow) {
          ws[cell_address].s = {
            font: { bold: true, size: 12, color: { rgb: "FFFFFF" }, name: "Calibri" },
            alignment: { horizontal: "center", vertical: "center" },
            fill: { fgColor: { rgb: "7C3AED" } },
            border: {
              top: { style: "thick", color: { rgb: "000000" } },
              bottom: { style: "thick", color: { rgb: "000000" } },
              left: { style: "medium", color: { rgb: "000000" } },
              right: { style: "medium", color: { rgb: "000000" } }
            }
          };
        }
        
        if (isDataRow) {
          const isEvenRow = (R - financialDashboardDataStart) % 2 === 0;
          ws[cell_address].s = {
            font: { size: 11, name: "Calibri" },
            alignment: { horizontal: "center", vertical: "center" },
            fill: { fgColor: { rgb: isEvenRow ? "F3E8FF" : "FAF5FF" } },
            border: {
              top: { style: "thin", color: { rgb: "000000" } },
              bottom: { style: "thin", color: { rgb: "000000" } },
              left: { style: "thin", color: { rgb: "000000" } },
              right: { style: "thin", color: { rgb: "000000" } }
            }
          };
          
          // Color coding for financial values
          if ((C === 1 || C === 6) && cellValue && typeof cellValue === 'string') {
            const value = parseFloat(cellValue.replace(',', '.'));
            if (!isNaN(value)) {
              ws[cell_address].s.font.color = { rgb: value >= 0 ? "059669" : "DC2626" };
              ws[cell_address].s.font.bold = true;
            }
          }
          
          // Status column styling
          if ((C === 2 || C === 3 || C === 7) && cellValue && typeof cellValue === 'string') {
            if (cellValue.includes('POSITIVE') || cellValue.includes('PROFIT') || cellValue.includes('REVENUE') || cellValue.includes('HEALTHY') || cellValue.includes('GROWTH')) {
              ws[cell_address].s.font.color = { rgb: "059669" };
              ws[cell_address].s.font.bold = true;
            } else if (cellValue.includes('NEGATIVE') || cellValue.includes('LOSS') || cellValue.includes('COSTS') || cellValue.includes('CRITICAL') || cellValue.includes('DECLINE')) {
              ws[cell_address].s.font.color = { rgb: "DC2626" };
              ws[cell_address].s.font.bold = true;
            }
          }
        }
      }
      
      // DRIVER PERFORMANCE TABLE
      if (R >= driverPerformanceHeaderRow && R <= driverTotalsRow && C <= 8) {
        const isHeaderRow = R === driverPerformanceHeaderRow;
        const isDataRow = R >= driverPerformanceDataStart && R <= driverPerformanceDataEnd;
        const isTotalsRow = R === driverTotalsRow;
        
        if (isHeaderRow) {
          ws[cell_address].s = {
            font: { bold: true, size: 12, color: { rgb: "FFFFFF" }, name: "Calibri" },
            alignment: { horizontal: "center", vertical: "center" },
            fill: { fgColor: { rgb: "F59E0B" } },
            border: {
              top: { style: "thick", color: { rgb: "000000" } },
              bottom: { style: "thick", color: { rgb: "000000" } },
              left: { style: "medium", color: { rgb: "000000" } },
              right: { style: "medium", color: { rgb: "000000" } }
            }
          };
        }
        
        if (isDataRow) {
          const isEvenRow = (R - driverPerformanceDataStart) % 2 === 0;
          ws[cell_address].s = {
            font: { size: 11, name: "Calibri" },
            alignment: { horizontal: "center", vertical: "center" },
            fill: { fgColor: { rgb: isEvenRow ? "FEF3C7" : "FFFBEB" } },
            border: {
              top: { style: "thin", color: { rgb: "000000" } },
              bottom: { style: "thin", color: { rgb: "000000" } },
              left: { style: "thin", color: { rgb: "000000" } },
              right: { style: "thin", color: { rgb: "000000" } }
            }
          };
          
          // Color code driver performance
          if (C === 4 && cellValue) { // Net amount
            const value = parseFloat(cellValue.toString());
            ws[cell_address].s.font.color = { rgb: value >= 0 ? "059669" : "DC2626" };
            ws[cell_address].s.font.bold = true;
          }
          
          if (C === 5 && cellValue && typeof cellValue === 'string') { // Performance status
            ws[cell_address].s.font.color = { rgb: cellValue.includes('PROFITABLE') ? "059669" : "DC2626" };
            ws[cell_address].s.font.bold = true;
          }
        }
        
        if (isTotalsRow) {
          ws[cell_address].s = {
            font: { bold: true, size: 12, color: { rgb: "FFFFFF" }, name: "Calibri" },
            alignment: { horizontal: "center", vertical: "center" },
            fill: { fgColor: { rgb: "D97706" } },
            border: {
              top: { style: "thick", color: { rgb: "000000" } },
              bottom: { style: "thick", color: { rgb: "000000" } },
              left: { style: "medium", color: { rgb: "000000" } },
              right: { style: "medium", color: { rgb: "000000" } }
            }
          };
        }
      }
      
      // TRANSACTION TABLE
      if (R >= transactionTableHeaderRow && R <= transactionTableDataEnd && C <= 10) {
        const isHeaderRow = R === transactionTableHeaderRow;
        const isDataRow = R >= transactionTableDataStart && R <= transactionTableDataEnd;
        
        if (isHeaderRow) {
          ws[cell_address].s = {
            font: { bold: true, size: 12, color: { rgb: "FFFFFF" }, name: "Calibri" },
            alignment: { horizontal: "center", vertical: "center" },
            fill: { fgColor: { rgb: "1E40AF" } },
            border: {
              top: { style: "thick", color: { rgb: "000000" } },
              bottom: { style: "thick", color: { rgb: "000000" } },
              left: { style: "medium", color: { rgb: "000000" } },
              right: { style: "medium", color: { rgb: "000000" } }
            }
          };
        }
        
        if (isDataRow) {
          const isEvenRow = (R - transactionTableDataStart) % 2 === 0;
          ws[cell_address].s = {
            font: { size: 10, name: "Calibri" },
            alignment: { 
              horizontal: C === 3 ? "left" : "center", 
              vertical: "center" 
            },
            fill: { fgColor: { rgb: isEvenRow ? "F1F5F9" : "FFFFFF" } },
            border: {
              top: { style: "thin", color: { rgb: "000000" } },
              bottom: { style: "thin", color: { rgb: "000000" } },
              left: { style: "thin", color: { rgb: "000000" } },
              right: { style: "thin", color: { rgb: "000000" } }
            }
          };
          
          // Financial columns coloring
          if (C === 6 && cellValue) { // Income
            ws[cell_address].s.font = { color: { rgb: "059669" }, bold: true, size: 10 };
          }
          if (C === 7 && cellValue) { // Expense
            ws[cell_address].s.font = { color: { rgb: "DC2626" }, bold: true, size: 10 };
          }
          if (C === 8) { // Balance
            const balance = parseFloat(cellValue?.toString() || '0');
            ws[cell_address].s.font = {
              color: { rgb: balance >= 0 ? "059669" : "DC2626" },
              bold: true,
              size: 10
            };
          }
          if (C === 9 && cellValue && typeof cellValue === 'string') { // Type
            if (cellValue.includes('INCOME')) {
              ws[cell_address].s.font.color = { rgb: "059669" };
            } else if (cellValue.includes('EXPENSE')) {
              ws[cell_address].s.font.color = { rgb: "DC2626" };
            }
            ws[cell_address].s.font.bold = true;
          }
          if (C === 10 && cellValue && typeof cellValue === 'string') { // Status
            ws[cell_address].s.font.color = { rgb: cellValue.includes('POSITIVE') ? "059669" : "DC2626" };
            ws[cell_address].s.font.bold = true;
          }
        }
      }
      
      // SUMMARY TABLE
      if (R >= summaryTableHeaderRow && R <= summaryTableDataEnd && C <= 8) {
        const isHeaderRow = R === summaryTableHeaderRow;
        const isDataRow = R >= summaryTableDataStart && R <= summaryTableDataEnd;
        
        if (isHeaderRow) {
          ws[cell_address].s = {
            font: { bold: true, size: 12, color: { rgb: "FFFFFF" }, name: "Calibri" },
            alignment: { horizontal: "center", vertical: "center" },
            fill: { fgColor: { rgb: "059669" } },
            border: {
              top: { style: "thick", color: { rgb: "000000" } },
              bottom: { style: "thick", color: { rgb: "000000" } },
              left: { style: "medium", color: { rgb: "000000" } },
              right: { style: "medium", color: { rgb: "000000" } }
            }
          };
        }
        
        if (isDataRow) {
          const isEvenRow = (R - summaryTableDataStart) % 2 === 0;
          ws[cell_address].s = {
            font: { size: 11, name: "Calibri", bold: true },
            alignment: { horizontal: "center", vertical: "center" },
            fill: { fgColor: { rgb: isEvenRow ? "ECFDF5" : "F0FDF4" } },
            border: {
              top: { style: "thin", color: { rgb: "000000" } },
              bottom: { style: "thin", color: { rgb: "000000" } },
              left: { style: "thin", color: { rgb: "000000" } },
              right: { style: "thin", color: { rgb: "000000" } }
            }
          };
          
          // Color code summary values
          if (C === 2 && cellValue) { // Amount
            const value = parseFloat(cellValue.toString());
            ws[cell_address].s.font.color = { rgb: value >= 0 ? "059669" : "DC2626" };
          }
          
          if ((C === 5 || C === 6) && cellValue && typeof cellValue === 'string') { // Status columns
            if (cellValue.includes('EXCELLENT') || cellValue.includes('SUCCESSFUL') || cellValue.includes('ACTIVE')) {
              ws[cell_address].s.font.color = { rgb: "059669" };
            } else if (cellValue.includes('ATTENTION') || cellValue.includes('REVIEW') || cellValue.includes('INACTIVE')) {
              ws[cell_address].s.font.color = { rgb: "DC2626" };
            }
          }
        }
      }
      
      // FOOTER STYLING
      const footerStart = summaryTableDataEnd + 3;
      if (R >= footerStart && C <= 10) {
        ws[cell_address].s = {
          font: { size: 10, color: { rgb: "6B7280" }, italic: true, name: "Calibri" },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "F9FAFB" } },
          border: {
            top: { style: "thin", color: { rgb: "000000" } },
            bottom: { style: "thin", color: { rgb: "000000" } },
            left: { style: "thin", color: { rgb: "000000" } },
            right: { style: "thin", color: { rgb: "000000" } }
          }
        };
      }
    }
  }

  // COMPREHENSIVE MERGE CONFIGURATIONS FOR TABLE STRUCTURE
  ws['!merges'] = [
    // Main header
    { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }, // Company name
    { s: { r: 0, c: 3 }, e: { r: 0, c: 10 } }, // Report title

    // Section headers (full width)
    { s: { r: executiveSummaryStart, c: 0 }, e: { r: executiveSummaryStart, c: 10 } },
    { s: { r: financialDashboardStart, c: 0 }, e: { r: financialDashboardStart, c: 10 } },
    { s: { r: driverPerformanceStart, c: 0 }, e: { r: driverPerformanceStart, c: 10 } },
    { s: { r: transactionTableStart, c: 0 }, e: { r: transactionTableStart, c: 10 } },
    { s: { r: summaryTableStart, c: 0 }, e: { r: summaryTableStart, c: 10 } },

    // Footer merges
    { s: { r: range.e.r - 1, c: 0 }, e: { r: range.e.r - 1, c: 3 } },
    { s: { r: range.e.r - 1, c: 4 }, e: { r: range.e.r - 1, c: 10 } },
    { s: { r: range.e.r, c: 0 }, e: { r: range.e.r, c: 4 } },
    { s: { r: range.e.r, c: 5 }, e: { r: range.e.r, c: 10 } }
  ];

  // ENHANCED PRINT SETUP
  ws['!margins'] = { 
    left: 0.5, 
    right: 0.5, 
    top: 0.8, 
    bottom: 0.8, 
    header: 0.3, 
    footer: 0.3 
  };
  
  ws['!printSetup'] = {
    paperSize: 9, // A4
    orientation: 'landscape',
    scale: 80,
    fitToWidth: 1,
    fitToHeight: 0,
    blackAndWhite: false,
    draft: false,
    cellComments: 'None',
    useFirstPageNumber: true,
    horizontalDpi: 600,
    verticalDpi: 600,
    copies: 1
  };

  // Add freeze panes for better navigation
  ws['!freeze'] = { xSplit: 1, ySplit: transactionTableHeaderRow + 1 };

  // Add worksheet to workbook
  XLSX.utils.book_append_sheet(wb, ws, 'Financial Report');

  // CREATE CHARTS SHEET
  const chartsData = [
    // Title
    ['EL-PROFESSOR - VISUAL ANALYTICS DASHBOARD', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],

    // Income vs Expenses Chart Data
    ['INCOME VS EXPENSES COMPARISON', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['Category', 'Amount (EUR)', '', '', '', '', '', '', '', ''],
    ['Total Income', totalIncome.toFixed(2), '', '', '', '', '', '', '', ''],
    ['Total Expenses', totalExpense.toFixed(2), '', '', '', '', '', '', '', ''],
    ['Net Result', netResult.toFixed(2), '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],

    // Monthly Trend Data
    ['MONTHLY FINANCIAL TREND', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['Month', 'Income', 'Expenses', 'Net', '', '', '', '', '', ''],

    // Calculate monthly data
    ...(() => {
      const monthlyData = new Map<string, { income: number; expense: number }>();
      sortedReceipts.forEach(receipt => {
        const month = new Date(receipt.date).toLocaleDateString('de-DE', { year: 'numeric', month: 'short' });
        const existing = monthlyData.get(month) || { income: 0, expense: 0 };
        monthlyData.set(month, {
          income: existing.income + receipt.income,
          expense: existing.expense + receipt.expense
        });
      });

      return Array.from(monthlyData.entries()).map(([month, data]) => [
        month,
        data.income.toFixed(2),
        data.expense.toFixed(2),
        (data.income - data.expense).toFixed(2),
        '', '', '', '', '', ''
      ]);
    })(),

    ['', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],

    // Driver Performance Chart Data
    ['DRIVER PERFORMANCE COMPARISON', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['Driver', 'Income (EUR)', 'Expenses (EUR)', 'Net (EUR)', '', '', '', '', '', ''],

    ...uniqueDrivers.map(driver => {
      const driverReceipts = receipts.filter(r => r.driverName === driver);
      const driverIncome = driverReceipts.reduce((sum, r) => sum + r.income, 0);
      const driverExpense = driverReceipts.reduce((sum, r) => sum + r.expense, 0);
      return [
        driver,
        driverIncome.toFixed(2),
        driverExpense.toFixed(2),
        (driverIncome - driverExpense).toFixed(2),
        '', '', '', '', '', ''
      ];
    }),

    ['', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],

    // Transaction Type Distribution
    ['TRANSACTION TYPE DISTRIBUTION', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['Type', 'Count', 'Percentage', '', '', '', '', '', '', ''],
    ['Income Transactions', receipts.filter(r => r.income > 0).length.toString(), ((receipts.filter(r => r.income > 0).length / receipts.length) * 100).toFixed(1) + '%', '', '', '', '', '', '', ''],
    ['Expense Transactions', receipts.filter(r => r.expense > 0).length.toString(), ((receipts.filter(r => r.expense > 0).length / receipts.length) * 100).toFixed(1) + '%', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],

    // Balance Evolution
    ['BALANCE EVOLUTION OVER TIME', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['Date', 'Balance (EUR)', '', '', '', '', '', '', '', ''],

    ...sortedReceipts.map(receipt => [
      new Date(receipt.date).toLocaleDateString('de-DE'),
      receipt.balance.toFixed(2),
      '', '', '', '', '', '', '', ''
    ]),

    ['', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],

    // Key Performance Indicators
    ['KEY PERFORMANCE INDICATORS (KPIs)', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['KPI', 'Value', 'Status', '', '', '', '', '', '', ''],
    ['Average Transaction Value', avgTransactionValue.toFixed(2) + ' EUR', avgTransactionValue > 100 ? 'HIGH' : 'MODERATE', '', '', '', '', '', '', ''],
    ['Income/Expense Ratio', totalExpense > 0 ? (totalIncome / totalExpense).toFixed(2) : 'N/A', totalIncome > totalExpense ? 'HEALTHY' : 'CRITICAL', '', '', '', '', '', '', ''],
    ['Profit Margin', totalIncome > 0 ? ((netResult / totalIncome) * 100).toFixed(1) + '%' : '0%', netResult >= 0 ? 'POSITIVE' : 'NEGATIVE', '', '', '', '', '', '', ''],
    ['Active Drivers', uniqueDrivers.length.toString(), uniqueDrivers.length > 5 ? 'EXCELLENT' : 'GOOD', '', '', '', '', '', '', ''],
    ['Transaction Volume', receipts.length.toString(), receipts.length > 50 ? 'HIGH' : 'MODERATE', '', '', '', '', '', '', '']
  ];

  const chartsWs = XLSX.utils.aoa_to_sheet(chartsData);

  // Style charts sheet
  chartsWs['!cols'] = Array(10).fill({ wch: 18 });

  const chartsRange = XLSX.utils.decode_range(chartsWs['!ref'] || 'A1');
  for (let R = chartsRange.s.r; R <= chartsRange.e.r; ++R) {
    for (let C = chartsRange.s.c; C <= chartsRange.e.c; ++C) {
      const cell_address = XLSX.utils.encode_cell({ c: C, r: R });
      if (!chartsWs[cell_address]) continue;

      const cellValue = chartsWs[cell_address].v;

      // Main title
      if (R === 0) {
        chartsWs[cell_address].s = {
          font: { bold: true, size: 24, color: { rgb: "FFFFFF" }, name: "Calibri" },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "1E3A8A" } },
          border: {
            top: { style: "thick", color: { rgb: "000000" } },
            bottom: { style: "thick", color: { rgb: "000000" } },
            left: { style: "thick", color: { rgb: "000000" } },
            right: { style: "thick", color: { rgb: "000000" } }
          }
        };
      }

      // Section headers
      if (cellValue && typeof cellValue === 'string' && cellValue.includes('COMPARISON') ||
          cellValue && typeof cellValue === 'string' && cellValue.includes('TREND') ||
          cellValue && typeof cellValue === 'string' && cellValue.includes('DISTRIBUTION') ||
          cellValue && typeof cellValue === 'string' && cellValue.includes('EVOLUTION') ||
          cellValue && typeof cellValue === 'string' && cellValue.includes('KPI')) {
        chartsWs[cell_address].s = {
          font: { bold: true, size: 14, color: { rgb: "FFFFFF" }, name: "Calibri" },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "059669" } },
          border: {
            top: { style: "thick", color: { rgb: "000000" } },
            bottom: { style: "thick", color: { rgb: "000000" } },
            left: { style: "medium", color: { rgb: "000000" } },
            right: { style: "medium", color: { rgb: "000000" } }
          }
        };
      }

      // Data cells with borders
      if (cellValue && cellValue !== '') {
        if (!chartsWs[cell_address].s) {
          chartsWs[cell_address].s = {};
        }
        if (!chartsWs[cell_address].s.border) {
          chartsWs[cell_address].s.border = {
            top: { style: "thin", color: { rgb: "000000" } },
            bottom: { style: "thin", color: { rgb: "000000" } },
            left: { style: "thin", color: { rgb: "000000" } },
            right: { style: "thin", color: { rgb: "000000" } }
          };
        }

        // Number formatting
        if (typeof cellValue === 'string' && cellValue.includes('.')) {
          const numValue = parseFloat(cellValue);
          if (!isNaN(numValue) && chartsWs[cell_address].s) {
            chartsWs[cell_address].s.font = {
              ...chartsWs[cell_address].s.font,
              color: { rgb: numValue >= 0 ? "059669" : "DC2626" },
              bold: true
            };
          }
        }

        // Status coloring
        if (typeof cellValue === 'string' &&
            (cellValue.includes('HIGH') || cellValue.includes('HEALTHY') || cellValue.includes('POSITIVE') ||
             cellValue.includes('EXCELLENT') || cellValue.includes('GOOD'))) {
          if (chartsWs[cell_address].s) {
            chartsWs[cell_address].s.font = {
              ...chartsWs[cell_address].s.font,
              color: { rgb: "059669" },
              bold: true
            };
          }
        } else if (typeof cellValue === 'string' &&
                   (cellValue.includes('CRITICAL') || cellValue.includes('NEGATIVE') || cellValue.includes('LOW'))) {
          if (chartsWs[cell_address].s) {
            chartsWs[cell_address].s.font = {
              ...chartsWs[cell_address].s.font,
              color: { rgb: "DC2626" },
              bold: true
            };
          }
        }
      }
    }
  }

  // Merge title cells
  chartsWs['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 9 } }
  ];

  XLSX.utils.book_append_sheet(wb, chartsWs, 'Charts & Analytics');

  // FILENAME GENERATION
  const today = new Date().toISOString().split('T')[0];
  const filterSuffix = isFiltered ? '_Filtered' : '';
  const periodSuffix = receipts.length > 0 ? 
    `_${new Date(sortedReceipts[0].date).toLocaleDateString('de-DE').replace(/\./g, '-')}_to_${new Date(sortedReceipts[sortedReceipts.length - 1].date).toLocaleDateString('de-DE').replace(/\./g, '-')}` : 
    '';
  const filename = `El-Professor_Professional_Report_${today}${periodSuffix}${filterSuffix}.xlsx`;
  
  // SAVE FILE
  XLSX.writeFile(wb, filename);

  console.log(`Professional Excel report created successfully: ${filename}`);
};

export const exportIncomeToExcel = (incomes: Income[], fromDate?: string, toDate?: string) => {
  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: "El-Professor - Umsätze Report",
    Subject: "Income and Revenue Analysis",
    Author: "El-Professor Management System",
    CreatedDate: new Date()
  };

  const sortedIncomes = [...incomes].sort((a, b) =>
    new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const totalAmount = incomes.reduce((sum, income) => sum + Number(income.amount), 0);
  const byType = {
    bargeld: incomes.filter(i => i.type === 'bargeld').reduce((sum, i) => sum + Number(i.amount), 0),
    umsatz: incomes.filter(i => i.type === 'umsatz').reduce((sum, i) => sum + Number(i.amount), 0),
    aktionen: incomes.filter(i => i.type === 'aktionen').reduce((sum, i) => sum + Number(i.amount), 0),
    trinkgeld: incomes.filter(i => i.type === 'trinkgeld').reduce((sum, i) => sum + Number(i.amount), 0)
  };

  const drivers = [...new Set(incomes.map(i => i.driver_name))];
  const byDriver = drivers.map(driver => {
    const driverIncomes = incomes.filter(i => i.driver_name === driver);
    return {
      name: driver,
      count: driverIncomes.length,
      bargeld: driverIncomes.filter(i => i.type === 'bargeld').reduce((sum, i) => sum + Number(i.amount), 0),
      umsatz: driverIncomes.filter(i => i.type === 'umsatz').reduce((sum, i) => sum + Number(i.amount), 0),
      aktionen: driverIncomes.filter(i => i.type === 'aktionen').reduce((sum, i) => sum + Number(i.amount), 0),
      trinkgeld: driverIncomes.filter(i => i.type === 'trinkgeld').reduce((sum, i) => sum + Number(i.amount), 0),
      total: driverIncomes.reduce((sum, i) => sum + Number(i.amount), 0)
    };
  });

  const excelData = [
    ['EL-PROFESSOR - UMSÄTZE BERICHT', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Zeitraum', fromDate && toDate ? `${fromDate} bis ${toDate}` : 'Alle Einträge', '', '', '', ''],
    ['Erstellt am', new Date().toLocaleString('de-DE'), '', '', '', ''],
    ['Gesamtanzahl', incomes.length.toString(), '', '', '', ''],
    ['', '', '', '', '', ''],

    ['ZUSAMMENFASSUNG NACH TYP', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Typ', 'Betrag (€)', 'Anteil', '', '', '', ''],
    ['Bargeld', byType.bargeld.toFixed(2), totalAmount > 0 ? ((byType.bargeld / totalAmount) * 100).toFixed(1) + '%' : '0%', '', '', '', ''],
    ['Umsatz', byType.umsatz.toFixed(2), totalAmount > 0 ? ((byType.umsatz / totalAmount) * 100).toFixed(1) + '%' : '0%', '', '', '', ''],
    ['Aktionen', byType.aktionen.toFixed(2), totalAmount > 0 ? ((byType.aktionen / totalAmount) * 100).toFixed(1) + '%' : '0%', '', '', '', ''],
    ['Trinkgeld', byType.trinkgeld.toFixed(2), totalAmount > 0 ? ((byType.trinkgeld / totalAmount) * 100).toFixed(1) + '%' : '0%', '', '', '', ''],
    ['GESAMT', totalAmount.toFixed(2), '100%', '', '', '', ''],
    ['', '', '', '', '', '', ''],

    ['ZUSAMMENFASSUNG NACH FAHRER', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Fahrer', 'Anzahl', 'Bargeld (€)', 'Umsatz (€)', 'Aktionen (€)', 'Trinkgeld (€)', 'Gesamt (€)'],
    ...byDriver.map(d => [
      d.name,
      d.count.toString(),
      d.bargeld.toFixed(2),
      d.umsatz.toFixed(2),
      d.aktionen.toFixed(2),
      d.trinkgeld.toFixed(2),
      d.total.toFixed(2)
    ]),
    ['', '', '', '', '', ''],

    ['DETAILLIERTE EINTRÄGE', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Datum', 'Fahrer', 'Typ', 'Beschreibung', 'Betrag (€)', 'ID', ''],
    ...sortedIncomes.map(income => [
      new Date(income.date).toLocaleDateString('de-DE'),
      income.driver_name,
      income.type === 'bargeld' ? 'Bargeld' :
      income.type === 'umsatz' ? 'Umsatz' :
      income.type === 'aktionen' ? 'Aktionen' : 'Trinkgeld',
      income.description,
      Number(income.amount).toFixed(2),
      income.id,
      ''
    ])
  ];

  const ws = XLSX.utils.aoa_to_sheet(excelData);

  ws['!cols'] = [
    { wch: 20 },
    { wch: 15 },
    { wch: 15 },
    { wch: 30 },
    { wch: 15 },
    { wch: 36 },
    { wch: 15 }
  ];

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let R = range.s.r; R <= range.e.r; ++R) {
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cell_address = XLSX.utils.encode_cell({ c: C, r: R });
      if (!ws[cell_address]) continue;

      const cellValue = ws[cell_address].v;

      if (R === 0) {
        ws[cell_address].s = {
          font: { bold: true, size: 18, color: { rgb: "FFFFFF" } },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "059669" } },
          border: {
            top: { style: "thick", color: { rgb: "000000" } },
            bottom: { style: "thick", color: { rgb: "000000" } },
            left: { style: "thick", color: { rgb: "000000" } },
            right: { style: "thick", color: { rgb: "000000" } }
          }
        };
      }

      if (cellValue && typeof cellValue === 'string' &&
          (cellValue.includes('ZUSAMMENFASSUNG') || cellValue.includes('DETAILLIERTE'))) {
        ws[cell_address].s = {
          font: { bold: true, size: 14, color: { rgb: "FFFFFF" } },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "10B981" } },
          border: {
            top: { style: "medium", color: { rgb: "000000" } },
            bottom: { style: "medium", color: { rgb: "000000" } },
            left: { style: "medium", color: { rgb: "000000" } },
            right: { style: "medium", color: { rgb: "000000" } }
          }
        };
      }
    }
  }

  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 5 } },
    { s: { r: 6, c: 0 }, e: { r: 6, c: 5 } },
    { s: { r: 14, c: 0 }, e: { r: 14, c: 5 } },
    { s: { r: 20, c: 0 }, e: { r: 20, c: 5 } }
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Umsätze');

  const filename = `umsaetze_${fromDate || 'all'}_to_${toDate || new Date().toISOString().split('T')[0]}.xlsx`;
  XLSX.writeFile(wb, filename);
};

export const exportSalariesToExcel = (salaries: SalaryCalculation[], periodStart: string, periodEnd: string) => {
  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title: "El-Professor - Gehaltsabrechnung",
    Subject: "Salary Report",
    Author: "El-Professor Management System",
    CreatedDate: new Date()
  };

  const totalRevenue = salaries.reduce((sum, s) => sum + s.revenue, 0);
  const totalTips = salaries.reduce((sum, s) => sum + s.tips, 0);
  const totalRevenueShare = salaries.reduce((sum, s) => sum + s.revenue_share, 0);
  const totalDue = salaries.reduce((sum, s) => sum + s.amount_due, 0);
  const paidCount = salaries.filter(s => s.status === 'paid').length;
  const unpaidCount = salaries.filter(s => s.status === 'unpaid').length;

  const excelData = [
    ['EL-PROFESSOR - GEHALTSABRECHNUNG', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Zeitraum', `${new Date(periodStart).toLocaleDateString('de-DE')} bis ${new Date(periodEnd).toLocaleDateString('de-DE')}`, '', '', '', '', ''],
    ['Erstellt am', new Date().toLocaleString('de-DE'), '', '', '', '', ''],
    ['Anzahl Fahrer', salaries.length.toString(), '', '', '', '', ''],
    ['', '', '', '', '', '', ''],

    ['ZUSAMMENFASSUNG', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Metrik', 'Betrag (€)', 'Status', '', '', '', ''],
    ['Gesamt Umsatz', totalRevenue.toFixed(2), '', '', '', '', ''],
    ['Gesamt Trinkgeld', totalTips.toFixed(2), '', '', '', '', ''],
    ['Gesamt Umsatzanteil', totalRevenueShare.toFixed(2), '', '', '', '', ''],
    ['Gesamt Fällig', totalDue.toFixed(2), '', '', '', '', ''],
    ['Bezahlt', paidCount.toString(), '', '', '', '', ''],
    ['Unbezahlt', unpaidCount.toString(), '', '', '', '', ''],
    ['', '', '', '', '', '', ''],

    ['GEHALTSÜBERSICHT PRO FAHRER', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['Fahrer', 'Umsatz (€)', 'Anteil (%)', 'Umsatzanteil (€)', 'Trinkgeld (€)', 'Fälliger Betrag (€)', 'Status'],
    ...salaries.map(salary => [
      salary.driver_name,
      salary.revenue.toFixed(2),
      (salary.salary_ratio * 100).toFixed(1) + '%',
      salary.revenue_share.toFixed(2),
      salary.tips.toFixed(2),
      salary.amount_due.toFixed(2),
      salary.status === 'paid' ? 'Bezahlt' : 'Unbezahlt'
    ]),
    ['', '', '', '', '', '', ''],
    ['GESAMT', totalRevenue.toFixed(2), '', totalRevenueShare.toFixed(2), totalTips.toFixed(2), totalDue.toFixed(2), '']
  ];

  const ws = XLSX.utils.aoa_to_sheet(excelData);

  ws['!cols'] = [
    { wch: 25 },
    { wch: 15 },
    { wch: 15 },
    { wch: 18 },
    { wch: 15 },
    { wch: 18 },
    { wch: 12 }
  ];

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  for (let R = range.s.r; R <= range.e.r; ++R) {
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cell_address = XLSX.utils.encode_cell({ c: C, r: R });
      if (!ws[cell_address]) continue;

      const cellValue = ws[cell_address].v;

      if (R === 0) {
        ws[cell_address].s = {
          font: { bold: true, size: 18, color: { rgb: "FFFFFF" } },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "3B82F6" } },
          border: {
            top: { style: "thick", color: { rgb: "000000" } },
            bottom: { style: "thick", color: { rgb: "000000" } },
            left: { style: "thick", color: { rgb: "000000" } },
            right: { style: "thick", color: { rgb: "000000" } }
          }
        };
      }

      if (cellValue && typeof cellValue === 'string' &&
          (cellValue.includes('ZUSAMMENFASSUNG') || cellValue.includes('GEHALTSÜBERSICHT'))) {
        ws[cell_address].s = {
          font: { bold: true, size: 14, color: { rgb: "FFFFFF" } },
          alignment: { horizontal: "center", vertical: "center" },
          fill: { fgColor: { rgb: "60A5FA" } },
          border: {
            top: { style: "medium", color: { rgb: "000000" } },
            bottom: { style: "medium", color: { rgb: "000000" } },
            left: { style: "medium", color: { rgb: "000000" } },
            right: { style: "medium", color: { rgb: "000000" } }
          }
        };
      }

      if (cellValue === 'GESAMT') {
        ws[cell_address].s = {
          font: { bold: true, size: 12, color: { rgb: "FFFFFF" } },
          alignment: { horizontal: "left", vertical: "center" },
          fill: { fgColor: { rgb: "1E40AF" } },
          border: {
            top: { style: "thick", color: { rgb: "000000" } },
            bottom: { style: "thick", color: { rgb: "000000" } },
            left: { style: "thick", color: { rgb: "000000" } },
            right: { style: "thick", color: { rgb: "000000" } }
          }
        };
      }
    }
  }

  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
    { s: { r: 6, c: 0 }, e: { r: 6, c: 6 } },
    { s: { r: 17, c: 0 }, e: { r: 17, c: 6 } }
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Gehälter');

  const periodLabel = periodStart === periodEnd ?
    new Date(periodStart).toLocaleDateString('de-DE').replace(/\./g, '-') :
    `${new Date(periodStart).toLocaleDateString('de-DE').replace(/\./g, '-')}_to_${new Date(periodEnd).toLocaleDateString('de-DE').replace(/\./g, '-')}`;

  const filename = `salaries_${periodLabel}.xlsx`;
  XLSX.writeFile(wb, filename);
};

// ─── Generic reusable table export ────────────────────────────────────────────

export interface ExportColumn {
  key: string;
  label: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  format?: (value: unknown) => string;
}

/**
 * The chrome `exportTableToExcel` writes around the caller's own columns.
 *
 * This dump satisfies no statutory form — it is a convenience export of an
 * operational list — so its wording follows the UI language, unlike the
 * Fahrtenbuch XLSX and the Stundennachweis PDF, whose German is prescribed.
 * The module stays pure: a screen passes its own translated labels, and the
 * German defaults below keep every existing caller byte-identical.
 */
export interface ExportChromeLabels {
  /** Printed in the first cell when there are no rows. */
  emptyState: string;
  /** Prefix of the filter line; the summary follows it. */
  activeFilters: string;
  /** Label of the totals row; `{count}` is the number of rows. */
  totalsRow: string;
  /** Footer line; `{count}` is the number of rows. */
  footer: string;
}

export const DEFAULT_EXPORT_CHROME: ExportChromeLabels = {
  emptyState:    'Keine Daten vorhanden',
  activeFilters: 'Aktive Filter:',
  totalsRow:     'Gesamt  ({count} Einträge)',
  footer:        'El-Professor Verwaltungssystem  —  {count} Datensätze exportiert',
};

function chromeText(template: string, count: number): string {
  return template.replace('{count}', String(count));
}

export interface ExportOptions {
  filename: string;
  sheetTitle: string;
  moduleName: string;
  columns: ExportColumn[];
  rows: Record<string, unknown>[];
  filterSummary?: string[];
  totals?: Record<string, string>;
  /** Defaults to the German wording this export has always had. */
  labels?: Partial<ExportChromeLabels>;
}

// ─── Design tokens ────────────────────────────────────────────────────────────
// Slate-900 header, slate-700 subheader, sky-700 column header, clean grids
const T = {
  TITLE_BG:     '0F2337',  // very dark navy — report header band
  TITLE_FG:     'FFFFFF',
  META_BG:      '1C3A52',  // slightly lighter navy — meta row
  META_FG:      'B8D4E8',  // muted sky text
  FILTER_BG:    'F1F5F9',  // near-white slate
  FILTER_FG:    '475569',  // slate-600
  FILTER_BORDER:'CBD5E1',  // slate-300
  COL_HEAD_BG:  '1D5F8A',  // sky-800 — column header
  COL_HEAD_FG:  'FFFFFF',
  COL_HEAD_BTM: '0F4C75',  // darker bottom accent line
  ROW_EVEN_BG:  'F7F9FC',  // very subtle off-white
  ROW_ODD_BG:   'FFFFFF',
  ROW_BORDER:   'DDE3EA',  // soft grid lines
  ROW_BORDER_V: 'DDE3EA',
  TOTAL_BG:     'E3EEF7',  // light sky tint
  TOTAL_FG:     '0F2337',
  TOTAL_ACCENT: '1D5F8A',  // top border accent
  FOOTER_BG:    'F1F5F9',
  FOOTER_FG:    '94A3B8',  // slate-400
  FOOTER_LINE:  'CBD5E1',
} as const;

// ─── Style helpers ────────────────────────────────────────────────────────────

function gridBorder() {
  return {
    top:    { style: 'thin',   color: { rgb: T.ROW_BORDER } },
    bottom: { style: 'thin',   color: { rgb: T.ROW_BORDER } },
    left:   { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
    right:  { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
  };
}

function outerBorder(color = T.COL_HEAD_BG) {
  return {
    top:    { style: 'medium', color: { rgb: color } },
    bottom: { style: 'medium', color: { rgb: color } },
    left:   { style: 'medium', color: { rgb: color } },
    right:  { style: 'medium', color: { rgb: color } },
  };
}

function cell(
  ws: XLSX.WorkSheet,
  r: number,
  c: number,
  value: string | number,
  style: object,
) {
  const addr = XLSX.utils.encode_cell({ r, c });
  ws[addr] = { t: typeof value === 'number' ? 'n' : 's', v: value, s: style };
}

function blank(ws: XLSX.WorkSheet, r: number, numCols: number, bg = 'FFFFFF') {
  for (let c = 0; c < numCols; c++) {
    const addr = XLSX.utils.encode_cell({ r, c });
    ws[addr] = { t: 's', v: '', s: { fill: { fgColor: { rgb: bg } } } };
  }
}

// ─── Main export function ─────────────────────────────────────────────────────

export function exportTableToExcel(opts: ExportOptions): void {
  const { filename, sheetTitle, moduleName, columns, rows, filterSummary = [], totals } = opts;
  const labels: ExportChromeLabels = { ...DEFAULT_EXPORT_CHROME, ...(opts.labels ?? {}) };
  const N = columns.length;
  const exportedAt  = new Date().toLocaleString('de-DE');
  const exportedDate = new Date().toLocaleDateString('de-DE');
  const exportedTime = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  const wb = XLSX.utils.book_new();
  wb.Props = {
    Title:       sheetTitle,
    Subject:     moduleName,
    Author:      'El-Professor Verwaltungssystem',
    Company:     'El-Professor',
    CreatedDate: new Date(),
  };

  const ws: XLSX.WorkSheet = {};
  let R = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 1 — REPORT HEADER (3 rows tall)
  // ═══════════════════════════════════════════════════════════════════════════

  // Row 0: top accent stripe (very thin, dark)
  for (let c = 0; c < N; c++) {
    const addr = XLSX.utils.encode_cell({ r: R, c });
    ws[addr] = {
      t: 's', v: '',
      s: { fill: { fgColor: { rgb: T.TITLE_BG } } },
    };
  }
  R++;

  // Row 1: TITLE — large bold white text on dark navy, left-aligned
  for (let c = 0; c < N; c++) {
    cell(ws, R, c, c === 0 ? sheetTitle : '', {
      font: { bold: true, sz: 20, color: { rgb: T.TITLE_FG }, name: 'Calibri Light' },
      fill: { fgColor: { rgb: T.TITLE_BG } },
      alignment: { horizontal: 'left', vertical: 'center', indent: 2 },
    });
  }
  R++;

  // Row 2: META — module name (left) + export date/time (right)
  for (let c = 0; c < N; c++) {
    const isLast = c === N - 1;
    const metaVal = c === 0
      ? moduleName.toUpperCase()
      : isLast
        ? `${exportedDate}  ${exportedTime}`
        : '';
    cell(ws, R, c, metaVal, {
      font: {
        bold:   c === 0,
        sz:     c === 0 ? 10 : 9,
        color:  { rgb: T.META_FG },
        name:   'Calibri',
        italic: c !== 0 && isLast,
      },
      fill: { fgColor: { rgb: T.META_BG } },
      alignment: {
        horizontal: isLast ? 'right' : 'left',
        vertical:   'center',
        indent:     c === 0 ? 2 : 0,
      },
      border: {
        bottom: { style: 'thin', color: { rgb: T.COL_HEAD_BG } },
      },
    });
  }
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 2 — FILTER CONTEXT (optional, 1 row)
  // ═══════════════════════════════════════════════════════════════════════════

  let filterRow = -1;
  if (filterSummary.length > 0) {
    filterRow = R;
    const filterText = `${labels.activeFilters}  ${filterSummary.join('   |   ')}`;
    for (let c = 0; c < N; c++) {
      cell(ws, R, c, c === 0 ? filterText : '', {
        font:      { sz: 9, color: { rgb: T.FILTER_FG }, italic: true, name: 'Calibri' },
        fill:      { fgColor: { rgb: T.FILTER_BG } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 2, wrapText: false },
        border: {
          top:    { style: 'thin', color: { rgb: T.FILTER_BORDER } },
          bottom: { style: 'thin', color: { rgb: T.FILTER_BORDER } },
          left:   c === 0 ? { style: 'thin', color: { rgb: T.FILTER_BORDER } } : undefined,
          right:  c === N - 1 ? { style: 'thin', color: { rgb: T.FILTER_BORDER } } : undefined,
        },
      });
    }
    R++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 3 — SPACER ROW (provides visual breathing room)
  // ═══════════════════════════════════════════════════════════════════════════

  blank(ws, R, N);
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 4 — COLUMN HEADERS
  // ═══════════════════════════════════════════════════════════════════════════

  const colHeaderRow = R;
  columns.forEach((col, c) => {
    cell(ws, R, c, col.label, {
      font:      { bold: true, sz: 10, color: { rgb: T.COL_HEAD_FG }, name: 'Calibri' },
      fill:      { fgColor: { rgb: T.COL_HEAD_BG } },
      alignment: { horizontal: col.align ?? 'left', vertical: 'center', wrapText: false, indent: col.align === 'left' ? 1 : 0 },
      border: {
        top:    { style: 'medium', color: { rgb: T.TITLE_BG } },
        bottom: { style: 'medium', color: { rgb: T.COL_HEAD_BTM } },
        left:   { style: 'thin',   color: { rgb: T.COL_HEAD_BG } },
        right:  { style: 'thin',   color: { rgb: T.COL_HEAD_BG } },
      },
    });
  });
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 5 — DATA ROWS
  // ═══════════════════════════════════════════════════════════════════════════

  rows.forEach((dataRow, i) => {
    const isEven = i % 2 === 0;
    const rowBg  = isEven ? T.ROW_EVEN_BG : T.ROW_ODD_BG;

    columns.forEach((col, c) => {
      const rawVal   = dataRow[col.key];
      const formatted = col.format
        ? col.format(rawVal)
        : rawVal == null ? '' : String(rawVal);

      cell(ws, R, c, formatted, {
        font:      { sz: 10, name: 'Calibri', color: { rgb: '1E293B' } },
        fill:      { fgColor: { rgb: rowBg } },
        alignment: {
          horizontal: col.align ?? 'left',
          vertical:   'center',
          wrapText:   false,
          indent:     col.align === 'left' ? 1 : 0,
        },
        border: {
          top:    { style: 'thin', color: { rgb: T.ROW_BORDER } },
          bottom: { style: 'thin', color: { rgb: T.ROW_BORDER } },
          left:   c === 0
            ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } }
            : { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
          right:  c === N - 1
            ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } }
            : { style: 'thin',   color: { rgb: T.ROW_BORDER_V } },
        },
      });
    });
    R++;
  });

  // Empty-state placeholder
  if (rows.length === 0) {
    const msg = labels.emptyState;
    for (let c = 0; c < N; c++) {
      cell(ws, R, c, c === 0 ? msg : '', {
        font:      { sz: 10, italic: true, color: { rgb: '94A3B8' }, name: 'Calibri' },
        fill:      { fgColor: { rgb: T.ROW_EVEN_BG } },
        alignment: { horizontal: 'left', vertical: 'center', indent: 1 },
        border:    gridBorder(),
      });
    }
    R++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 6 — TOTALS / SUMMARY ROW (optional)
  // ═══════════════════════════════════════════════════════════════════════════

  if (totals) {
    // Top-border accent line (1-row cap before totals)
    for (let c = 0; c < N; c++) {
      const addr = XLSX.utils.encode_cell({ r: R, c });
      ws[addr] = {
        t: 's', v: '',
        s: {
          fill:   { fgColor: { rgb: T.TOTAL_ACCENT } },
          border: {
            top:    { style: 'medium', color: { rgb: T.TITLE_BG } },
            bottom: { style: 'medium', color: { rgb: T.TITLE_BG } },
          },
        },
      };
    }
    R++;

    columns.forEach((col, c) => {
      const isLabel = c === 0;
      const val     = isLabel ? chromeText(labels.totalsRow, rows.length) : (totals[col.key] ?? '');
      cell(ws, R, c, val, {
        font: {
          bold:  true,
          sz:    10,
          color: { rgb: isLabel ? T.TOTAL_ACCENT : T.TOTAL_FG },
          name:  'Calibri',
        },
        fill:      { fgColor: { rgb: T.TOTAL_BG } },
        alignment: {
          horizontal: isLabel ? 'left' : (col.align ?? 'right'),
          vertical:   'center',
          indent:     isLabel ? 1 : 0,
        },
        border: {
          top:    { style: 'medium', color: { rgb: T.TOTAL_ACCENT } },
          bottom: { style: 'medium', color: { rgb: T.TITLE_BG }    },
          left:   c === 0     ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } } : { style: 'thin', color: { rgb: T.ROW_BORDER_V } },
          right:  c === N - 1 ? { style: 'medium', color: { rgb: T.COL_HEAD_BG } } : { style: 'thin', color: { rgb: T.ROW_BORDER_V } },
        },
      });
    });
    R++;
  } else {
    // Even without a totals row, close the table with a medium bottom border
    const lastDataR = R - 1;
    for (let c = 0; c < N; c++) {
      const addr = XLSX.utils.encode_cell({ r: lastDataR, c });
      if (ws[addr] && ws[addr].s) {
        ws[addr].s.border = {
          ...(ws[addr].s.border ?? {}),
          bottom: { style: 'medium', color: { rgb: T.COL_HEAD_BG } },
        };
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOCK 7 — FOOTER BAND
  // ═══════════════════════════════════════════════════════════════════════════

  R++; // one blank spacer row above footer

  // Footer line 1: system name + record count
  for (let c = 0; c < N; c++) {
    const isFirst = c === 0;
    const isLast  = c === N - 1;
    const val = isFirst
      ? chromeText(labels.footer, rows.length)
      : isLast
        ? exportedAt
        : '';
    cell(ws, R, c, val, {
      font:  { sz: 8, color: { rgb: T.FOOTER_FG }, italic: true, name: 'Calibri' },
      fill:  { fgColor: { rgb: T.FOOTER_BG } },
      alignment: {
        horizontal: isLast ? 'right' : 'left',
        vertical:   'center',
        indent:     isFirst ? 2 : 0,
      },
      border: {
        top:    { style: 'thin',   color: { rgb: T.FOOTER_LINE } },
        bottom: { style: 'thin',   color: { rgb: T.FOOTER_LINE } },
        left:   isFirst ? { style: 'thin', color: { rgb: T.FOOTER_LINE } } : undefined,
        right:  isLast  ? { style: 'thin', color: { rgb: T.FOOTER_LINE } } : undefined,
      },
    });
  }

  const footerRow = R;
  R++;

  // ═══════════════════════════════════════════════════════════════════════════
  // WORKSHEET SETTINGS
  // ═══════════════════════════════════════════════════════════════════════════

  // Range
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: R - 1, c: N - 1 } });

  // Column widths — use provided widths; auto-min of 10
  ws['!cols'] = columns.map(col => ({ wch: Math.max(col.width ?? 18, 10) }));

  // Row heights (in points)
  const rowHeights: { [key: number]: { hpt: number } } = {
    0: { hpt: 4  },   // accent stripe — short
    1: { hpt: 32 },   // title row
    2: { hpt: 18 },   // meta row
  };
  if (filterRow >= 0) rowHeights[filterRow] = { hpt: 16 };
  rowHeights[colHeaderRow - 1] = { hpt: 6 };  // spacer
  rowHeights[colHeaderRow]     = { hpt: 22 };  // column headers
  for (let i = colHeaderRow + 1; i < colHeaderRow + 1 + rows.length; i++) {
    rowHeights[i] = { hpt: 18 };
  }
  rowHeights[footerRow] = { hpt: 14 };
  ws['!rows'] = Array.from({ length: R }, (_, i) => rowHeights[i] ?? { hpt: 18 });

  // Freeze pane: freeze everything above and including the column-header row
  ws['!freeze'] = { xSplit: 0, ySplit: colHeaderRow + 1 };

  // AutoFilter on column-header row
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({
      s: { r: colHeaderRow, c: 0 },
      e: { r: colHeaderRow, c: N - 1 },
    }),
  };

  // Cell merges
  const merges: XLSX.Range[] = [
    // Accent stripe — full width
    { s: { r: 0, c: 0 }, e: { r: 0, c: N - 1 } },
    // Title row — full width
    { s: { r: 1, c: 0 }, e: { r: 1, c: N - 1 } },
    // Meta row — left part (module name) spans all but last cell
    { s: { r: 2, c: 0 }, e: { r: 2, c: N - 2 } },
    // Footer — left part spans all but last cell
    { s: { r: footerRow, c: 0 }, e: { r: footerRow, c: N - 2 } },
  ];
  if (filterRow >= 0) {
    merges.push({ s: { r: filterRow, c: 0 }, e: { r: filterRow, c: N - 1 } });
  }
  ws['!merges'] = merges;

  // Print settings
  ws['!margins'] = { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 };

  XLSX.utils.book_append_sheet(wb, ws, moduleName.slice(0, 31));

  const safeFilename = filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`;
  XLSX.writeFile(wb, safeFilename);
}